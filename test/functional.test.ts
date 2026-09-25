import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openDatabase, type Db } from '../src/storage.js';
import { GatewayCore, type DeliveryJob } from '../src/core.js';
import { createHttpServer } from '../src/http.js';
import { ApprovalClient, ApiError } from '../src/client.js';
import { TelegramGateway, type TelegramTransport, type Update } from '../src/telegram.js';
import { createSchema, type CreateInput } from '../src/model.js';
import { parseConfig } from '../src/config.js';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-functional-'));
  dirs.push(dir);
  const path = join(dir, 'gateway.sqlite');
  const db = openDatabase(path);
  dbs.push(db);
  let time = new Date('2026-09-24T12:00:00.000Z');
  const core = new GatewayCore(db, () => time);
  return { db, path, core, advance: (ms: number) => { time = new Date(time.getTime() + ms); }, clock: () => time };
}

function input(key = 'job:one'): CreateInput {
  return createSchema.parse({ idempotencyKey: key, action: 'maintenance', title: 'Run maintenance',
    description: 'Compact local records', details: [{ label: 'Target', value: 'staging' }],
    expiresInSeconds: 900, metadata: { ticket: 'OPS-1', options: { b: 2, a: 1 } } });
}

function mockFetch(app: ReturnType<typeof createHttpServer>): typeof fetch {
  return async (url, init) => {
    const path = new URL(String(url)).pathname;
    const response = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: path,
      headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
  };
}

function button(job: DeliveryJob, updateId: number, decision: 'a' | 'r' = 'a'): Update {
  return { update_id: updateId, callback_query: { id: `callback-${updateId}`, data: `${decision}:${job.callbackRef}`,
    from: { id: 7 }, message: { message_id: 101, chat: { id: -100 } } } };
}

test('configuration binds locally and requires distinct client credentials and numeric IDs', () => {
  const env = { CLIENT_KEYS: `primary:${'a'.repeat(32)},secondary:${'b'.repeat(32)}`, TELEGRAM_BOT_TOKEN: 'test-token-12345',
    TELEGRAM_CHAT_ID: '-100123', TELEGRAM_APPROVER_IDS: '7,8' };
  const config = parseConfig(env);
  assert.deepEqual([...config.clientKeys], [['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]);
  assert.equal(config.HOST, '127.0.0.1');
  assert.equal(config.PORT, 3080);
  assert.equal(config.DATABASE_PATH, './data/gateway.sqlite');
  assert.equal(parseConfig({ ...env, HOST: '0.0.0.0', PORT: '4000' }).PORT, 4000);
  for (const invalid of [
    { CLIENT_KEYS: 'primary:short' }, { CLIENT_KEYS: 'primary:replace-with-a-long-random-secret' },
    { CLIENT_KEYS: `primary:${'a'.repeat(32)},primary:${'b'.repeat(32)}` },
    { CLIENT_KEYS: `primary:${'a'.repeat(32)},secondary:${'a'.repeat(32)}` },
    { CLIENT_KEYS: `bad client:${'a'.repeat(32)}` },
    { CLIENT_KEYS: '' },
    { TELEGRAM_BOT_TOKEN: 'replace-with-dedicated-bot-token' },
    { TELEGRAM_CHAT_ID: 'chat-name' }, { TELEGRAM_APPROVER_IDS: '@alice' },
    { TELEGRAM_APPROVER_IDS: '' }, { PORT: '0' },
  ]) assert.throws(() => parseConfig({ ...env, ...invalid }));
});

test('migration and canonical idempotency survive restart without changing approved content', () => {
  const { db, path, core, clock } = setup();
  const original = input();
  const created = core.create('primary', original).request;
  const stored = db.prepare('SELECT fingerprint, content_json, claim_token_hash FROM requests WHERE id = ?').get(created.id) as {
    fingerprint: string; content_json: string; claim_token_hash: string | null;
  };
  assert.equal(stored.claim_token_hash, null);
  const job = core.dueDeliveries()[0]!;
  core.deliverySucceeded(created.id, '101');
  core.decide(job.callbackRef, '101', '7', 'approved');
  const claim = core.claim('primary', created.id);
  const final = core.report('primary', created.id, claim.claimToken, 'failed', 'Maintenance failed');
  for (const field of ['action', 'title', 'description', 'details', 'metadata', 'createdAt', 'expiresAt'] as const)
    assert.deepEqual(final[field], created[field]);
  assert.equal(final.status, 'approved');
  assert.equal(final.executionStatus, 'failed');
  const rowAfter = db.prepare('SELECT fingerprint, content_json, claim_token_hash FROM requests WHERE id = ?').get(created.id) as typeof stored;
  assert.equal(rowAfter.fingerprint, stored.fingerprint);
  assert.equal(rowAfter.content_json, stored.content_json);
  assert.notEqual(rowAfter.claim_token_hash, claim.claimToken);
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, clock);
  assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 1);
  const reordered = { ...original, metadata: { options: { a: 1, b: 2 }, ticket: 'OPS-1' } };
  assert.equal(restarted.create('primary', reordered).request.id, created.id);
  assert.throws(() => restarted.create('primary', { ...original, details: [{ label: 'Target', value: 'production' }] }), { code: 'idempotency_conflict' });
  assert.equal(restarted.get('primary', created.id).executionStatus, 'failed');
});

test('API validates the full request boundary and never echoes rejected values', async () => {
  const { core } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  const base = input();
  const badBodies: Array<[string, unknown]> = [
    ['expiry below minimum', { ...base, expiresInSeconds: 59 }],
    ['expiry above maximum', { ...base, expiresInSeconds: 86401 }],
    ['uppercase action', { ...base, action: 'Deploy' }],
    ['invalid idempotency key', { ...base, idempotencyKey: 'bad key' }],
    ['title too long', { ...base, title: 'x'.repeat(101) }],
    ['description control character', { ...base, description: 'a\u0000b' }],
    ['too many details', { ...base, details: Array.from({ length: 11 }, () => ({ label: 'A', value: 'B' })) }],
    ['detail value too long', { ...base, details: [{ label: 'A', value: 'v'.repeat(161) }] }],
    ['metadata too large', { ...base, metadata: { secret: 'sensitive-' + 'x'.repeat(2048) } }],
    ['Telegram escaped text too long', { ...base, description: '&'.repeat(1000) }],
    ['unknown field', { ...base, executeUrl: 'https://example.invalid/action' }],
  ];
  for (const [name, body] of badBodies) {
    const response = await app.inject({ method: 'POST', url: '/v1/requests', headers: { ...headers, 'content-type': 'application/json' }, payload: JSON.stringify(body) });
    assert.equal(response.statusCode, 400, name);
    assert.equal(response.json().error.code, 'invalid_input', name);
    assert.ok(response.json().error.issues.length > 0, name);
    assert.doesNotMatch(response.body, /sensitive-|example\.invalid/, name);
  }
  const tooBig = await app.inject({ method: 'POST', url: '/v1/requests', headers,
    payload: { ...base, description: 'x'.repeat(13_000) } });
  assert.equal(tooBig.statusCode, 413);
  assert.equal(tooBig.json().error.code, 'invalid_input');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: {
    idempotencyKey: 'minimal', action: 'maintenance', title: 'Minimal', description: 'Safe', expiresInSeconds: 60,
  } })).statusCode, 201);
  await app.close();
});

test('all v1 routes require a valid key while health stays public', async () => {
  const { core } = setup();
  const id = core.create('primary', input()).request.id;
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const routes: Array<['GET' | 'POST', string]> = [
    ['POST', '/v1/requests'], ['GET', `/v1/requests/${id}`],
    ['POST', `/v1/requests/${id}/cancel`], ['POST', `/v1/requests/${id}/claim`],
    ['POST', `/v1/requests/${id}/result`],
  ];
  for (const [method, url] of routes) {
    for (const authorization of [undefined, 'Bearer wrong', 'Basic abc']) {
      const response = await app.inject({ method, url, ...(authorization ? { headers: { authorization } } : {}) });
      assert.equal(response.statusCode, 401, `${method} ${url}`);
      assert.deepEqual(response.json(), { error: { code: 'unauthorized', message: 'valid client bearer key required' } });
    }
  }
  assert.deepEqual((await app.inject({ method: 'GET', url: '/health' })).json(), { status: 'ok' });
  assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 200);
  await app.close();
});

test('HTTP state errors, cancellation, and result token checks have stable responses', async () => {
  const { core } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  const created = await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input() });
  const id = created.json().id as string;
  const missing = '123e4567-e89b-42d3-a456-426614174000';
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${missing}`, headers })).json().error.code, 'not_found');
  assert.equal((await app.inject({ method: 'GET', url: '/v1/requests/not-a-uuid', headers })).json().error.code, 'invalid_input');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/claim`, headers, payload: {} })).json().error.code, 'not_claimable');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/result`, headers,
    payload: { claimToken: 'short', status: 'succeeded', summary: 'done' } })).json().error.code, 'invalid_input');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/result`, headers,
    payload: { claimToken: 'x'.repeat(43), status: 'succeeded', summary: 'done' } })).json().error.code, 'invalid_claim_token');
  const cancelled = await app.inject({ method: 'POST', url: `/v1/requests/${id}/cancel`, headers, payload: {} });
  assert.equal(cancelled.json().status, 'cancelled');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/cancel`, headers, payload: {} })).json().error.code, 'invalid_state');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/claim`, headers, payload: {} })).json().error.code, 'not_claimable');
  await app.close();
});

test('decision expiry boundary and execution result stay independent', () => {
  const { core, advance } = setup();
  const before = core.create('primary', input('before-deadline')).request;
  const beforeJob = core.dueDeliveries()[0]!;
  core.deliverySucceeded(before.id, '101');
  advance(899_999);
  assert.equal(core.decide(beforeJob.callbackRef, '101', '7', 'approved').request?.status, 'approved');
  advance(2);
  const claim = core.claim('primary', before.id);
  assert.equal(claim.request.status, 'approved');
  assert.equal(core.report('primary', before.id, claim.claimToken, 'failed', 'Target unavailable').executionStatus, 'failed');
  assert.equal(core.get('primary', before.id).status, 'approved');

  const atDeadline = core.create('primary', input('at-deadline')).request;
  const expiringJob = core.dueDeliveries()[0]!;
  core.deliverySucceeded(atDeadline.id, '102');
  advance(900_000);
  const late = core.decide(expiringJob.callbackRef, '102', '7', 'approved');
  assert.equal(late.outcome, 'Already expired.');
  assert.equal(core.get('primary', atDeadline.id).status, 'expired');
  assert.equal(core.get('primary', atDeadline.id).executionStatus, 'unclaimed');
});

test('concurrent delivery calls send once and retry schedule survives restart', async () => {
  const { core, db, path, advance, clock } = setup();
  const request = core.create('primary', input()).request;
  let release!: () => void;
  let sends = 0;
  const transport: TelegramTransport = {
    async check() {},
    async send() { sends++; await new Promise<void>((resolve) => { release = resolve; }); return '101'; },
    async poll() { return []; }, async answer() {}, async edit() {},
  };
  const gateway = new TelegramGateway(core, transport, '-100', new Set(['7']));
  const first = gateway.deliverDue();
  await gateway.deliverDue();
  assert.equal(sends, 1);
  release(); await first;
  assert.equal(core.get('primary', request.id).deliveryStatus, 'delivered');
  assert.equal(core.get('primary', request.id).deliveryAttempts, 1);

  const retry = core.create('primary', input('retry-after-restart')).request;
  core.deliveryFailed(retry.id, true, 'temporary transport error');
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, clock);
  assert.equal(restarted.get('primary', retry.id).deliveryStatus, 'retrying');
  assert.equal(restarted.dueDeliveries().length, 0);
  advance(2000);
  assert.equal(restarted.dueDeliveries()[0]?.id, retry.id);
});

test('an unrecorded Telegram send cannot authorize a different message, and expiry stops retries', async () => {
  const { core, advance } = setup();
  const request = core.create('primary', input()).request;
  const job = core.dueDeliveries()[0]!;
  // Model Telegram accepting message 100, then the transport failing before its ID is committed.
  core.deliveryFailed(request.id, true, 'uncertain send');
  advance(2000);
  core.deliverySucceeded(request.id, '101');
  const answers: string[] = [];
  const gateway = new TelegramGateway(core, {
    async check() {}, async send() { throw new Error('unexpected send'); }, async poll() { return []; },
    async answer(_id, answer) { answers.push(answer); }, async edit() {},
  }, '-100', new Set(['7']));
  const duplicate = button(job, 1);
  duplicate.callback_query!.message!.message_id = 100;
  await gateway.process(duplicate);
  assert.equal(core.get('primary', request.id).status, 'pending');
  assert.match(answers[0]!, /does not belong/);
  await gateway.process(button(job, 2));
  assert.equal(core.get('primary', request.id).status, 'approved');

  const expiring = core.create('primary', input('retry-expiry')).request;
  core.deliveryFailed(expiring.id, true, 'temporary');
  advance(900_000);
  assert.equal(core.get('primary', expiring.id).status, 'expired');
  assert.deepEqual(core.dueDeliveries(), []);
});

test('callback acknowledgement and message edit failures do not undo a committed decision', async () => {
  const { core } = setup();
  const request = core.create('primary', input()).request;
  const job = core.dueDeliveries()[0]!;
  core.deliverySucceeded(request.id, '101');
  const errors: string[] = [];
  const gateway = new TelegramGateway(core, {
    async check() {}, async send() { throw new Error('unexpected send'); }, async poll() { return []; },
    async answer() { throw new Error('Telegram unavailable'); },
    async edit() { throw new Error('Telegram unavailable'); },
  }, '-100', new Set(['7']), (message) => errors.push(message));
  await gateway.process(button(job, 1));
  assert.equal(core.get('primary', request.id).status, 'approved');
  assert.equal(core.get('primary', request.id).decidedBy, '7');
  assert.deepEqual(errors, ['Could not answer Telegram callback', 'Could not update Telegram decision message']);
  assert.equal(core.claim('primary', request.id).request.executionStatus, 'claimed');
});

test('malformed and unknown Telegram callbacks leave the request pending', async () => {
  const { core } = setup();
  const request = core.create('primary', input()).request;
  const job = core.dueDeliveries()[0]!;
  core.deliverySucceeded(request.id, '101');
  const answers: string[] = [];
  const gateway = new TelegramGateway(core, {
    async check() {}, async send() { throw new Error('unexpected send'); }, async poll() { return []; },
    async answer(_id, answer) { answers.push(answer); }, async edit() {},
  }, '-100', new Set(['7']));
  await gateway.process({ update_id: 1 });
  await gateway.process({ update_id: 2, callback_query: { id: 'missing-message', data: `a:${job.callbackRef}`, from: { id: 7 } } });
  await gateway.process({ update_id: 3, callback_query: { id: 'malformed', data: 'a:payload-and-secrets', from: { id: 7 }, message: { message_id: 101, chat: { id: -100 } } } });
  await gateway.process({ update_id: 4, callback_query: { id: 'unknown-ref', data: `a:${'z'.repeat(16)}`, from: { id: 7 }, message: { message_id: 101, chat: { id: -100 } } } });
  assert.equal(core.get('primary', request.id).status, 'pending');
  assert.deepEqual(answers, ['This button is no longer available.', 'This button is no longer available.', 'This button does not belong to an active request message.']);
});

test('Telegram delivery failure makes readiness false until a retry succeeds', async () => {
  const { core, advance } = setup();
  const request = core.create('primary', input()).request;
  let attempts = 0;
  const transport: TelegramTransport = {
    async check() {},
    async send() { if (attempts++ === 0) throw new Error('temporary failure'); return '101'; },
    async poll(_offset, signal) { return new Promise<Update[]>((_resolve, reject) =>
      signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true })); },
    async answer() {}, async edit() {},
  };
  const gateway = new TelegramGateway(core, transport, '-100', new Set(['7']));
  try {
    await gateway.start();
    assert.equal(gateway.isReady(), false);
    assert.equal(core.get('primary', request.id).deliveryStatus, 'retrying');
    advance(2000);
    await gateway.deliverDue();
    assert.equal(gateway.isReady(), true);
    assert.equal(core.get('primary', request.id).deliveryStatus, 'delivered');
  } finally { await gateway.stop(); }
  assert.equal(gateway.isReady(), false);
});

test('out-of-order Telegram updates settle once and persist offset across restart', async () => {
  const { core, db, path, clock } = setup();
  const request = core.create('primary', input()).request;
  const job = core.dueDeliveries()[0]!;
  core.deliverySucceeded(request.id, '101');
  const offsets: number[] = [];
  const answers: string[] = [];
  const edits: string[] = [];
  let pollCount = 0;
  const transport: TelegramTransport = {
    async check() {}, async send() { throw new Error('No new send expected'); },
    async poll(offset, signal) {
      offsets.push(offset);
      if (pollCount++ === 0) return [button(job, 4, 'r'), button(job, 3), button(job, 3)];
      return new Promise<Update[]>((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('stopped', 'AbortError')), { once: true }));
    },
    async answer(_id, message) { answers.push(message); },
    async edit(_job, _id, status) { edits.push(status); },
  };
  const gateway = new TelegramGateway(core, transport, '-100', new Set(['7']));
  try {
    await gateway.start();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 500;
      const check = () => {
        if (core.getOffset() === 5) resolve();
        else if (Date.now() >= deadline) reject(new Error('polling did not commit offset'));
        else setTimeout(check, 5);
      };
      check();
    });
    assert.equal(core.get('primary', request.id).status, 'approved');
    assert.deepEqual(edits, ['approved']);
    assert.deepEqual(answers, ['Approved.', 'Already approved.']);
    assert.deepEqual(offsets.slice(0, 2), [0, 5]);
  } finally { await gateway.stop(); }
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  assert.equal(new GatewayCore(reopened, clock).getOffset(), 5);
});

test('client methods complete a failed execution and preserve API errors', async () => {
  const { core } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const client = new ApprovalClient({ baseUrl: 'http://local', apiKey: 'a'.repeat(32), fetch: mockFetch(app), pollIntervalMs: 10 });
  const request = await client.createRequest({ idempotencyKey: 'sdk:one', action: 'maintenance', title: 'Run maintenance',
    description: 'Compact local records', expiresInSeconds: 60 });
  assert.deepEqual(request.details, []);
  assert.deepEqual(request.metadata, {});
  assert.equal((await client.getRequest(request.id)).status, 'pending');
  await assert.rejects(client.createRequest({ idempotencyKey: 'sdk:one', action: 'maintenance', title: 'Changed',
    description: 'Compact local records', expiresInSeconds: 60 }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'idempotency_conflict');
  const job = core.dueDeliveries()[0]!;
  core.deliverySucceeded(request.id, '101');
  core.decide(job.callbackRef, '101', '7', 'approved');
  assert.equal((await client.waitForDecision(request.id, { timeoutMs: 100 })).status, 'approved');
  const claim = await client.claim(request.id);
  assert.equal(claim.request.executionStatus, 'claimed');
  await assert.rejects(client.claim(request.id), (error: unknown) => error instanceof ApiError && error.code === 'not_claimable');
  const final = await client.reportResult(request.id, { claimToken: claim.claimToken, status: 'failed', summary: 'Target unavailable' });
  assert.equal(final.executionStatus, 'failed');
  assert.equal(final.resultSummary, 'Target unavailable');
  assert.equal((await client.getRequest(request.id)).executionStatus, 'failed');
  const cancellable = await client.createRequest({ idempotencyKey: 'sdk:cancel', action: 'maintenance', title: 'Cancel me',
    description: 'No work required', expiresInSeconds: 60 });
  assert.equal((await client.cancel(cancellable.id)).status, 'cancelled');
  await app.close();
});

test('two clients share one gateway without sharing requests or idempotency keys', async () => {
  const { core, db, path, clock } = setup();
  const keys = new Map([['alpha', 'a'.repeat(32)], ['beta', 'b'.repeat(32)]]);
  const app = createHttpServer(core, keys, () => true);
  const fetcher = mockFetch(app);
  const alpha = new ApprovalClient({ baseUrl: 'http://local', apiKey: keys.get('alpha')!, fetch: fetcher });
  const beta = new ApprovalClient({ baseUrl: 'http://local', apiKey: keys.get('beta')!, fetch: fetcher });
  const proposal = { idempotencyKey: 'same-key', action: 'maintenance', title: 'Alpha task',
    description: 'One client task', expiresInSeconds: 900 };
  const a = await alpha.createRequest(proposal);
  const b = await beta.createRequest({ ...proposal, title: 'Beta task' });
  const forgedOwner = await app.inject({ method: 'POST', url: '/v1/requests',
    headers: { authorization: `Bearer ${keys.get('alpha')}` }, payload: { ...proposal, clientId: 'beta' } });
  assert.equal(forgedOwner.statusCode, 400);
  assert.notEqual(a.id, b.id);
  assert.equal(a.clientId, 'alpha');
  assert.equal(b.clientId, 'beta');
  assert.equal((await alpha.createRequest(proposal)).id, a.id);
  await assert.rejects(alpha.createRequest({ ...proposal, title: 'Changed task' }), { status: 409, code: 'idempotency_conflict' });
  for (const operation of [
    () => beta.getRequest(a.id),
    () => beta.cancel(a.id),
    () => beta.claim(a.id),
    () => beta.reportResult(a.id, { claimToken: 'x'.repeat(43), status: 'succeeded', summary: 'wrong client' }),
  ]) await assert.rejects(operation(), { status: 404, code: 'not_found' });
  assert.equal((await alpha.getRequest(a.id)).status, 'pending');
  const job = core.dueDeliveries().find((due) => due.id === a.id)!;
  core.deliverySucceeded(a.id, '101');
  core.decide(job.callbackRef, '101', '7', 'approved');
  await assert.rejects(beta.claim(a.id), { status: 404, code: 'not_found' });
  const claim = await alpha.claim(a.id);
  await assert.rejects(beta.reportResult(a.id, { claimToken: claim.claimToken, status: 'succeeded', summary: 'wrong client' }),
    { status: 404, code: 'not_found' });
  assert.equal((await alpha.reportResult(a.id, { claimToken: claim.claimToken, status: 'succeeded', summary: 'done' })).executionStatus, 'succeeded');
  assert.equal((await beta.cancel(b.id)).status, 'cancelled');
  await app.close();
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const afterRestart = new GatewayCore(reopened, clock);
  assert.equal(afterRestart.get('alpha', a.id).executionStatus, 'succeeded');
  assert.throws(() => afterRestart.get('beta', a.id), { code: 'not_found' });
  assert.equal(afterRestart.get('beta', b.id).status, 'cancelled');
  const rotated = createHttpServer(afterRestart, new Map([['alpha', 'c'.repeat(32)], ['beta', keys.get('beta')!]]), () => true);
  assert.equal((await rotated.inject({ method: 'GET', url: `/v1/requests/${a.id}`,
    headers: { authorization: `Bearer ${'c'.repeat(32)}` } })).statusCode, 200);
  assert.equal((await rotated.inject({ method: 'GET', url: `/v1/requests/${a.id}`,
    headers: { authorization: `Bearer ${keys.get('alpha')}` } })).statusCode, 401);
  await rotated.close();
});
