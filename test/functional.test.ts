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
const routes = () => new Map([['primary', { chatId: '-100', approverIds: new Set(['7']) }]]);

function mockFetch(app: ReturnType<typeof createHttpServer>): typeof fetch {
  return async (url, init) => {
    const parsed = new URL(String(url));
    const path = parsed.pathname + parsed.search;
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
    TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-100123', approverIds: ['7', '8'] }, secondary: { chatId: '-100456', approverIds: ['9'] } }) };
  const config = parseConfig(env);
  assert.deepEqual([...config.clientKeys], [['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]);
  assert.equal(config.routes.get('primary')?.chatId, '-100123');
  assert.deepEqual([...config.routes.get('secondary')!.approverIds], ['9']);
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
    { TELEGRAM_ROUTES: 'not-json' },
    { TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-100123', approverIds: ['7'] } }) },
    { TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-100123', approverIds: ['7'] }, secondary: { chatId: 'chat-name', approverIds: ['9'] } }) },
    { TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-100123', approverIds: ['7', '7'] }, secondary: { chatId: '-100456', approverIds: ['9'] } }) },
    { TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-100123', approverIds: ['7'] }, secondary: { chatId: '-100123', approverIds: ['9'] } }) },
    { TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-0100123', approverIds: ['7'] }, secondary: { chatId: '-100456', approverIds: ['9'] } }) },
    { TELEGRAM_ROUTES: JSON.stringify({ primary: { chatId: '-100123', approverIds: ['07'] }, secondary: { chatId: '-100456', approverIds: ['9'] } }) },
    { TELEGRAM_CHAT_ID: '-100123' }, { PORT: '0' },
  ]) assert.throws(() => parseConfig({ ...env, ...invalid }));
  const single = parseConfig({ CLIENT_KEYS: `primary:${'a'.repeat(32)}`, TELEGRAM_BOT_TOKEN: 'test-token-12345',
    TELEGRAM_CHAT_ID: '-100123', TELEGRAM_APPROVER_IDS: '7,8' });
  assert.equal(single.routes.get('primary')?.chatId, '-100123');
  assert.throws(() => parseConfig({ CLIENT_KEYS: `primary:${'a'.repeat(32)}`, TELEGRAM_BOT_TOKEN: 'test-token-12345',
    TELEGRAM_CHAT_ID: '-100123', TELEGRAM_APPROVER_IDS: '7,7' }), /must not contain duplicates/);
  assert.throws(() => parseConfig({ ...env, TELEGRAM_ROUTES: undefined, TELEGRAM_CHAT_ID: '-100123', TELEGRAM_APPROVER_IDS: '7' }),
    /Multiple clients require TELEGRAM_ROUTES/);
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
  core.deliverySucceeded(created.id, '-100', '101');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
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
  assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 6);
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
    ['POST', '/v1/requests'], ['GET', '/v1/requests'], ['GET', `/v1/requests/${id}`], ['GET', `/v1/requests/${id}/events`],
    ['POST', '/v1/client-keys'], ['GET', '/v1/client-keys'], ['GET', '/v1/audit-events'],
    ['POST', '/v1/client-keys/123e4567-e89b-42d3-a456-426614174000/revoke'],
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

test('scoped client keys are least privilege, owner scoped, revocable, and survive restart without storing secrets', async () => {
  const { db, path, core, clock } = setup();
  const keys = new Map([['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]);
  const app = createHttpServer(core, keys, () => true);
  const primary = { authorization: `Bearer ${keys.get('primary')}` };
  const secondary = { authorization: `Bearer ${keys.get('secondary')}` };
  const issue = async (body: unknown, headers = primary) => app.inject({ method: 'POST', url: '/v1/client-keys', headers: { ...headers, 'content-type': 'application/json' },
    payload: JSON.stringify(body) });
  const created = await issue({ label: 'Worker', scopes: ['requests:create', 'requests:read'] });
  assert.equal(created.statusCode, 201);
  const issued = created.json() as { id: string; key: string; clientId: string; scopes: string[] };
  assert.equal(issued.clientId, 'primary');
  assert.match(issued.key, /^jgk_[A-Za-z0-9_-]{43}$/);
  const stored = db.prepare('SELECT key_hash, scopes_json FROM client_keys WHERE id = ?').get(issued.id) as { key_hash: string; scopes_json: string };
  assert.equal(stored.key_hash.length, 64);
  assert.doesNotMatch(JSON.stringify(stored), new RegExp(issued.key));
  const scoped = { authorization: `Bearer ${issued.key}` };
  const request = (await app.inject({ method: 'POST', url: '/v1/requests', headers: scoped, payload: input('scoped:one') })).json();
  assert.equal(request.clientId, 'primary');
  const otherRequest = core.create('secondary', input('scoped:other')).request;
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${otherRequest.id}`, headers: scoped })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${request.id}`, headers: scoped })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${request.id}/events`, headers: scoped })).statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/requests', headers: scoped })).statusCode, 200);
  for (const url of [`/v1/requests/${request.id}/cancel`, `/v1/requests/${request.id}/claim`, `/v1/requests/${request.id}/result`]) {
    const denied = await app.inject({ method: 'POST', url, headers: scoped, payload: {} });
    assert.equal(denied.statusCode, 403, url);
    assert.equal(denied.json().error.code, 'insufficient_scope');
  }
  assert.equal((await app.inject({ method: 'GET', url: '/v1/client-keys', headers: scoped })).statusCode, 403);
  assert.equal((await issue({ label: 'Escalation', scopes: ['requests:claim'] }, scoped)).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/client-keys/${issued.id}/revoke`, headers: scoped, payload: {} })).statusCode, 403);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/client-keys/${issued.id}/revoke`, headers: secondary, payload: {} })).statusCode, 404);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/client-keys', headers: secondary })).json().items.length, 0);
  const readOnly = (await issue({ label: 'Observer', scopes: ['requests:read'] })).json();
  const listed = (await app.inject({ method: 'GET', url: '/v1/client-keys?limit=1', headers: primary })).json();
  assert.equal(listed.items.length, 1);
  assert.equal(typeof listed.nextCursor, 'string');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/client-keys?limit=1&cursor=${listed.nextCursor}`, headers: primary })).json().items.length, 1);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(issued.key));
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(readOnly.key));
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers: { authorization: `Bearer ${readOnly.key}` }, payload: input('scoped:two') })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${request.id}`, headers: { authorization: `Bearer ${readOnly.key}` } })).statusCode, 200);
  const revoke = await app.inject({ method: 'POST', url: `/v1/client-keys/${issued.id}/revoke`, headers: primary, payload: {} });
  assert.equal(revoke.statusCode, 200);
  assert.equal(typeof revoke.json().revokedAt, 'string');
  assert.equal((await app.inject({ method: 'POST', url: `/v1/client-keys/${issued.id}/revoke`, headers: primary, payload: {} })).json().revokedAt, revoke.json().revokedAt);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/requests', headers: scoped })).statusCode, 401);
  await app.close();
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = createHttpServer(new GatewayCore(reopened, clock), new Map([['primary', 'c'.repeat(32)]]), () => true);
  assert.equal((await restarted.inject({ method: 'GET', url: '/v1/requests', headers: scoped })).statusCode, 401);
  assert.equal((await restarted.inject({ method: 'GET', url: `/v1/requests/${request.id}`, headers: { authorization: `Bearer ${readOnly.key}` } })).statusCode, 200);
  assert.equal((await restarted.inject({ method: 'GET', url: '/v1/client-keys', headers: { authorization: `Bearer ${'c'.repeat(32)}` } })).json().items.length, 2);
  await restarted.close();
  const removed = createHttpServer(new GatewayCore(reopened, clock), new Map([['secondary', keys.get('secondary')!]]), () => true);
  assert.equal((await removed.inject({ method: 'GET', url: `/v1/requests/${request.id}`, headers: { authorization: `Bearer ${readOnly.key}` } })).statusCode, 401);
  await removed.close();
});

test('every issued-key request scope authorizes only its intended operation', async () => {
  const { core } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const bootstrap = { authorization: `Bearer ${'a'.repeat(32)}` };
  const issue = async (scope: 'requests:create' | 'requests:read' | 'requests:cancel' | 'requests:claim' | 'requests:result') => {
    const response = await app.inject({ method: 'POST', url: '/v1/client-keys', headers: bootstrap,
      payload: { label: scope, scopes: [scope] } });
    assert.equal(response.statusCode, 201);
    return { authorization: `Bearer ${response.json().key as string}` };
  };
  const creator = await issue('requests:create');
  const reader = await issue('requests:read');
  const canceller = await issue('requests:cancel');
  const claimant = await issue('requests:claim');
  const reporter = await issue('requests:result');
  const cancelled = (await app.inject({ method: 'POST', url: '/v1/requests', headers: creator, payload: input('scope:cancel') })).json();
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${cancelled.id}`, headers: creator })).statusCode, 403);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${cancelled.id}`, headers: reader })).statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${cancelled.id}/cancel`, headers: canceller, payload: {} })).statusCode, 200);
  const approved = (await app.inject({ method: 'POST', url: '/v1/requests', headers: creator, payload: input('scope:claim') })).json();
  const job = core.dueDeliveries().find((item) => item.id === approved.id)!;
  core.deliverySucceeded(approved.id, '-100', '101');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
  const claim = (await app.inject({ method: 'POST', url: `/v1/requests/${approved.id}/claim`, headers: claimant, payload: {} })).json();
  assert.equal(claim.request.executionStatus, 'claimed');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${approved.id}`, headers: claimant })).statusCode, 403);
  const report = await app.inject({ method: 'POST', url: `/v1/requests/${approved.id}/result`, headers: reporter,
    payload: { claimToken: claim.claimToken, status: 'succeeded', summary: 'Done' } });
  assert.equal(report.statusCode, 200);
  assert.equal(report.json().executionStatus, 'succeeded');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${approved.id}`, headers: reporter })).statusCode, 403);
  await app.close();
});

test('client key creation validates labels, scopes, expiry, and cursor without echoing submitted secrets', async () => {
  const { core, clock } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  for (const body of [
    { label: '', scopes: ['requests:read'] }, { label: 'x'.repeat(81), scopes: ['requests:read'] },
    { label: 'bad\nlabel', scopes: ['requests:read'] }, { label: 'Bad', scopes: [] },
    { label: 'Bad', scopes: ['requests:read', 'requests:read'] }, { label: 'Bad', scopes: ['keys:manage'] },
    { label: 'Bad', scopes: ['requests:read'], clientId: 'secondary' },
    { label: 'Bad', scopes: ['requests:read'], expiresAt: clock().toISOString() },
    { label: 'Bad', scopes: ['requests:read'], expiresAt: '2026-02-30T12:00:00.000Z' },
    { label: 'Bad', scopes: ['requests:read'], expiresAt: '2026-09-24T14:00:00+02:00' },
    { label: 'Bad', scopes: ['requests:read'], expiresAt: '2026-09-24T12:01:00.0001Z' },
  ]) {
    const response = await app.inject({ method: 'POST', url: '/v1/client-keys', headers, payload: body });
    assert.equal(response.statusCode, 400);
    assert.equal(response.json().error.code, 'invalid_input');
  }
  for (const query of ['limit=0', 'limit=101', 'cursor=broken', 'extra=value'])
    assert.equal((await app.inject({ method: 'GET', url: `/v1/client-keys?${query}`, headers })).statusCode, 400, query);
  for (const query of ['limit=0', 'limit=101', 'cursor=broken', 'requestId=bad', 'keyId=bad', 'extra=value'])
    assert.equal((await app.inject({ method: 'GET', url: `/v1/audit-events?${query}`, headers })).statusCode, 400, query);
  await app.close();
});

test('issued-key expiry and audit attribute successful actions without storing credentials', async () => {
  const { core, db, advance, clock, path } = setup();
  const keys = new Map([['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]);
  const app = createHttpServer(core, keys, () => true);
  const bootstrap = { authorization: `Bearer ${keys.get('primary')}` };
  const expiry = new Date(clock().getTime() + 60_000).toISOString();
  const issue = await app.inject({ method: 'POST', url: '/v1/client-keys', headers: bootstrap,
    payload: { label: 'Worker', scopes: ['requests:create', 'requests:claim', 'requests:result'], expiresAt: expiry } });
  assert.equal(issue.statusCode, 201);
  const issued = issue.json();
  assert.equal(issued.expiresAt, expiry);
  const scoped = { authorization: `Bearer ${issued.key as string}` };
  const request = (await app.inject({ method: 'POST', url: '/v1/requests', headers: scoped, payload: input('audit:one') })).json();
  assert.equal(request.clientId, 'primary');
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers: scoped, payload: input('audit:one') })).statusCode, 200);
  const job = core.dueDeliveries().find((item) => item.id === request.id)!;
  core.deliverySucceeded(request.id, '-100', '101');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
  const claim = (await app.inject({ method: 'POST', url: `/v1/requests/${request.id}/claim`, headers: scoped, payload: {} })).json();
  assert.equal(claim.request.executionStatus, 'claimed');
  const result = await app.inject({ method: 'POST', url: `/v1/requests/${request.id}/result`, headers: scoped,
    payload: { claimToken: claim.claimToken, status: 'succeeded', summary: 'Done' } });
  assert.equal(result.statusCode, 200);
  assert.equal((await app.inject({ method: 'GET', url: '/v1/audit-events', headers: scoped })).statusCode, 403);
  const revoke = await app.inject({ method: 'POST', url: `/v1/client-keys/${issued.id}/revoke`, headers: bootstrap, payload: {} });
  assert.equal(revoke.statusCode, 200);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/client-keys/${issued.id}/revoke`, headers: bootstrap, payload: {} })).statusCode, 200);
  const audit = (await app.inject({ method: 'GET', url: '/v1/audit-events', headers: bootstrap })).json();
  assert.deepEqual(audit.items.map((event: { type: string }) => event.type),
    ['key.revoked', 'execution.succeeded', 'execution.claimed', 'request.created', 'key.issued']);
  assert.deepEqual(audit.items.map((event: { actorKeyId: string | null }) => event.actorKeyId),
    [null, issued.id, issued.id, issued.id, null]);
  assert.equal(audit.items[0].subjectKeyId, issued.id);
  assert.equal(audit.items[4].subjectKeyId, issued.id);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/v1/audit-events?requestId=${request.id}`, headers: bootstrap })).json()
    .items.map((event: { type: string }) => event.type), ['execution.succeeded', 'execution.claimed', 'request.created']);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/v1/audit-events?keyId=${issued.id}`, headers: bootstrap })).json()
    .items.map((event: { type: string }) => event.type), audit.items.map((event: { type: string }) => event.type));
  const page = (await app.inject({ method: 'GET', url: '/v1/audit-events?limit=2', headers: bootstrap })).json();
  assert.equal(page.items.length, 2);
  assert.equal((await app.inject({ method: 'GET', url: `/v1/audit-events?limit=2&cursor=${page.nextCursor}`, headers: bootstrap })).json().items.length, 2);
  const other = core.create('secondary', input('audit:other')).request;
  assert.deepEqual((await app.inject({ method: 'GET', url: '/v1/audit-events', headers: { authorization: `Bearer ${keys.get('secondary')}` } })).json()
    .items.map((event: { requestId: string }) => event.requestId), [other.id]);
  assert.deepEqual((await app.inject({ method: 'GET', url: `/v1/audit-events?keyId=${issued.id}`, headers: { authorization: `Bearer ${keys.get('secondary')}` } })).json().items, []);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(issued.key));
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(claim.claimToken));
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit_events').all()), new RegExp(issued.key));
  assert.doesNotMatch(JSON.stringify(db.prepare('SELECT * FROM audit_events').all()), new RegExp(claim.claimToken));
  await app.close();
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restartedCore = new GatewayCore(reopened, clock);
  const restarted = createHttpServer(restartedCore, keys, () => true);
  assert.equal((await restarted.inject({ method: 'GET', url: '/v1/audit-events', headers: bootstrap })).json().items.length, 5);
  await restarted.close();
  const noExpiry = restartedCore.issueClientKey('primary', 'Permanent', ['requests:read']);
  assert.equal(noExpiry.expiresAt, null);
  const expiring = restartedCore.issueClientKey('primary', 'Temporary', ['requests:read'], new Date(clock().getTime() + 1000).toISOString());
  advance(1000);
  const after = createHttpServer(new GatewayCore(reopened, clock), keys, () => true);
  assert.equal((await after.inject({ method: 'GET', url: '/v1/requests', headers: { authorization: `Bearer ${expiring.key}` } })).statusCode, 401);
  assert.equal((await after.inject({ method: 'GET', url: '/v1/requests', headers: { authorization: `Bearer ${noExpiry.key}` } })).statusCode, 200);
  await after.close();
});

test('migration adds audit and nullable expiry to an existing issued-key database', () => {
  const { db, path, core, clock } = setup();
  const existing = core.issueClientKey('primary', 'Existing reader', ['requests:read']);
  db.exec('DROP TABLE audit_events');
  db.exec('ALTER TABLE client_keys DROP COLUMN expires_at');
  db.prepare("DELETE FROM schema_migrations WHERE version = '006_key_expiry_audit.sql'").run();
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const upgraded = new GatewayCore(reopened, clock);
  assert.equal(upgraded.authenticateClientKey(existing.key)?.id, existing.id);
  assert.equal(upgraded.listClientKeys('primary', { limit: 20 }).items[0]?.expiresAt, null);
  assert.deepEqual(upgraded.listAuditEvents('primary', { limit: 20 }).items, []);
  upgraded.revokeClientKey('primary', existing.id);
  assert.deepEqual(upgraded.listAuditEvents('primary', { limit: 20 }).items.map((event) => event.type), ['key.revoked']);
});

test('listing is owner scoped, filtered, ordered, paginated, and reflects expiry', async () => {
  const { core, advance } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]), () => true);
  const primary = { authorization: `Bearer ${'a'.repeat(32)}` };
  const secondary = { authorization: `Bearer ${'b'.repeat(32)}` };
  const first = core.create('primary', input('list:first')).request;
  advance(1);
  const second = core.create('primary', input('list:second')).request;
  const other = core.create('secondary', input('list:other')).request;
  core.cancel('primary', second.id);
  const read = async (url: string, headers = primary) => app.inject({ method: 'GET', url, headers });

  const page = (await read('/v1/requests?limit=1')).json();
  assert.deepEqual(page.items.map((item: { id: string }) => item.id), [second.id]);
  assert.equal(typeof page.nextCursor, 'string');
  const next = (await read(`/v1/requests?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`)).json();
  assert.deepEqual(next.items.map((item: { id: string }) => item.id), [first.id]);
  assert.equal(next.nextCursor, null);
  assert.deepEqual((await read('/v1/requests?status=cancelled')).json().items.map((item: { id: string }) => item.id), [second.id]);
  assert.deepEqual((await read('/v1/requests?deliveryStatus=pending&executionStatus=unclaimed')).json().items.map((item: { id: string }) => item.id), [second.id, first.id]);
  assert.deepEqual((await read('/v1/requests', secondary)).json().items.map((item: { id: string }) => item.id), [other.id]);

  advance(900_000);
  assert.deepEqual((await read('/v1/requests?status=expired')).json().items.map((item: { id: string }) => item.id), [first.id]);
  assert.equal((await read('/v1/requests?status=pending')).json().items.length, 0);
  for (const query of ['limit=0', 'limit=101', 'limit=1.5', 'status=unknown', 'deliveryStatus=unknown', 'executionStatus=unknown', 'cursor=broken', 'extra=value']) {
    const response = await read(`/v1/requests?${query}`);
    assert.equal(response.statusCode, 400, query);
    assert.equal(response.json().error.code, 'invalid_input', query);
  }
  await app.close();
});

test('attention filters find unresolved delivery failures, old claims, and pending expiries without changing their state', async () => {
  const { core, advance } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]), () => true);
  const primary = { authorization: `Bearer ${'a'.repeat(32)}` };
  const reader = core.issueClientKey('primary', 'Monitor', ['requests:read']);
  const read = async (query: string, authorization = primary.authorization) => app.inject({ method: 'GET',
    url: `/v1/requests?${query}`, headers: { authorization } });
  const ids = (page: { items: Array<{ id: string }> }) => page.items.map((item) => item.id);

  const failed = core.create('primary', input('attention:delivery')).request;
  core.deliveryFailed(failed.id, false, 'Telegram refused delivery');
  const otherFailed = core.create('secondary', input('attention:other')).request;
  core.deliveryFailed(otherFailed.id, false, 'other client');
  const first = core.create('primary', input('attention:claim-one')).request;
  const firstRef = core.dueDeliveries().find((job) => job.id === first.id)!.callbackRef;
  core.deliverySucceeded(first.id, '-100', '101');
  core.decide(firstRef, '-100', '101', '7', 'approved');
  const firstClaim = core.claim('primary', first.id);
  advance(60_000);
  const second = core.create('primary', input('attention:claim-two')).request;
  const secondRef = core.dueDeliveries().find((job) => job.id === second.id)!.callbackRef;
  core.deliverySucceeded(second.id, '-100', '102');
  core.decide(secondRef, '-100', '102', '7', 'approved');
  core.claim('primary', second.id);
  advance(60_000);
  const third = core.create('primary', input('attention:claim-three')).request;
  const thirdRef = core.dueDeliveries().find((job) => job.id === third.id)!.callbackRef;
  core.deliverySucceeded(third.id, '-100', '103');
  core.decide(thirdRef, '-100', '103', '7', 'approved');
  const thirdClaim = core.claim('primary', third.id);
  core.report('primary', third.id, thirdClaim.claimToken, 'succeeded', 'Done');
  const cutoff = '2026-09-24T12:01:00.000Z';
  assert.deepEqual(ids((await read('status=pending&deliveryStatus=failed', `Bearer ${reader.key}`)).json()), [failed.id]);
  assert.deepEqual(ids((await read(`executionStatus=claimed&claimedBefore=${cutoff}`)).json()), [first.id]);
  const page = (await read('executionStatus=claimed&claimedBefore=2026-09-24T12:02:00.000Z&limit=1')).json();
  assert.deepEqual(ids(page), [second.id]);
  assert.deepEqual(ids((await read(`executionStatus=claimed&claimedBefore=2026-09-24T12:02:00.000Z&limit=1&cursor=${page.nextCursor}`)).json()), [first.id]);
  assert.deepEqual(ids((await read('status=pending&expiresBefore=2026-09-24T12:15:00.001Z')).json()), [failed.id]);
  assert.deepEqual(ids((await read('status=pending&expiresBefore=2026-09-24T12:15:00.000Z')).json()), []);
  assert.deepEqual(ids((await read('status=pending&deliveryStatus=failed', `Bearer ${'b'.repeat(32)}`)).json()), [otherFailed.id]);
  for (const query of ['claimedBefore=nope', 'expiresBefore=2026-09-24', 'claimedBefore=2026-09-24T12:00:00+02:00',
    'expiresBefore=2026-02-30T12:00:00.000Z', 'claimedBefore=2026-09-24T12:00:00.0001Z'])
    assert.equal((await read(query)).statusCode, 400, query);
  assert.equal(core.get('primary', first.id).executionStatus, 'claimed');
  assert.equal(core.get('primary', failed.id).deliveryStatus, 'failed');
  assert.ok(firstClaim.claimToken);
  await app.close();
});

test('event timeline records lifecycle transitions once, in order, without credentials or request content', async () => {
  const { core, db, advance } = setup();
  const created = core.create('primary', input('timeline:approved')).request;
  assert.equal(core.create('primary', input('timeline:approved')).created, false);
  const job = core.dueDeliveries()[0]!;
  core.deliveryFailed(created.id, true, 'temporary send error');
  advance(2_000);
  core.deliverySucceeded(created.id, '-100', '101');
  core.deliverySucceeded(created.id, '-100', '101');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
  const claim = core.claim('primary', created.id);
  assert.throws(() => core.claim('primary', created.id), { code: 'not_claimable' });
  core.report('primary', created.id, claim.claimToken, 'succeeded', 'private result summary');
  assert.throws(() => core.report('primary', created.id, claim.claimToken, 'succeeded', 'again'), { code: 'invalid_state' });
  const events = core.events('primary', created.id, { limit: 50 }).items;
  assert.deepEqual(events.map((event) => event.type), [
    'request.created', 'delivery.retry_scheduled', 'delivery.delivered', 'decision.approved', 'execution.claimed', 'execution.succeeded',
  ]);
  assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3, 4, 5, 6]);
  assert.deepEqual(events.map((event) => event.attempt), [null, 1, 2, null, null, null]);
  assert.equal(events[3]?.actorId, '7');
  assert.ok(events.every((event) => !Number.isNaN(Date.parse(event.occurredAt))));
  const stored = JSON.stringify(db.prepare('SELECT * FROM request_events WHERE request_id = ?').all(created.id));
  assert.doesNotMatch(stored, /private result summary|Compact local records|OPS-1|temporary send error|claimToken|callback_ref/);
  assert.doesNotMatch(JSON.stringify(events), new RegExp(claim.claimToken));
});

test('timeline API is owner scoped and paginated; expiry, cancellation, rejection and terminal delivery are recorded', async () => {
  const { core, advance } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)], ['secondary', 'b'.repeat(32)]]), () => true);
  const primary = { authorization: `Bearer ${'a'.repeat(32)}` };
  const secondary = { authorization: `Bearer ${'b'.repeat(32)}` };
  const expired = core.create('primary', input('timeline:expired')).request;
  const cancelled = core.create('primary', input('timeline:cancelled')).request;
  core.cancel('primary', cancelled.id);
  const rejected = core.create('primary', input('timeline:rejected')).request;
  const rejectedJob = core.dueDeliveries().find((job) => job.id === rejected.id)!;
  core.deliverySucceeded(rejected.id, '-100', '101');
  core.decide(rejectedJob.callbackRef, '-100', '101', '7', 'rejected');
  const failed = core.create('primary', input('timeline:failed')).request;
  core.deliveryFailed(failed.id, false, 'terminal');
  advance(900_000);
  const read = (id: string, query = '', headers = primary) => app.inject({ method: 'GET', url: `/v1/requests/${id}/events${query}`, headers });
  const page = (await read(expired.id, '?limit=1')).json();
  assert.deepEqual(page.items.map((event: { type: string }) => event.type), ['request.created']);
  assert.equal(page.nextCursor, '1');
  assert.deepEqual((await read(expired.id, `?limit=1&cursor=${page.nextCursor}`)).json().items.map((event: { type: string }) => event.type), ['decision.expired']);
  assert.equal((await read(expired.id, '?cursor=2')).json().nextCursor, null);
  assert.deepEqual(core.events('primary', cancelled.id, {}).items.map((event) => event.type), ['request.created', 'decision.cancelled']);
  assert.deepEqual(core.events('primary', rejected.id, {}).items.map((event) => event.type), ['request.created', 'delivery.delivered', 'decision.rejected']);
  assert.deepEqual(core.events('primary', failed.id, {}).items.map((event) => event.type), ['request.created', 'delivery.failed', 'decision.expired']);
  assert.equal((await read(expired.id, '', secondary)).statusCode, 404);
  assert.equal((await read('123e4567-e89b-42d3-a456-426614174000')).statusCode, 404);
  for (const query of ['?limit=0', '?limit=101', '?limit=1.5', '?cursor=0', '?cursor=no', '?extra=value'])
    assert.equal((await read(expired.id, query)).statusCode, 400, query);
  await app.close();
});

test('timeline schema upgrade leaves existing history empty and records later transitions', () => {
  const { db, path, core, clock } = setup();
  const request = core.create('primary', input('timeline:legacy')).request;
  db.exec('DROP TABLE request_events');
  db.prepare("DELETE FROM schema_migrations WHERE version = '004_request_events.sql'").run();
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, clock);
  assert.equal(restarted.get('primary', request.id).status, 'pending');
  assert.deepEqual(restarted.events('primary', request.id, {}).items, []);
  assert.equal(restarted.cancel('primary', request.id).status, 'cancelled');
  assert.deepEqual(restarted.events('primary', request.id, {}).items.map((event) => event.type), ['decision.cancelled']);
  assert.equal((reopened.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = '004_request_events.sql'").get() as { count: number }).count, 1);
});

test('a failed event write rolls back the request state change', () => {
  const { db, core } = setup();
  const request = core.create('primary', input('timeline:atomic')).request;
  db.exec("CREATE TRIGGER block_events BEFORE INSERT ON request_events BEGIN SELECT RAISE(ABORT, 'blocked event'); END");
  assert.throws(() => core.cancel('primary', request.id), /blocked event/);
  assert.equal(core.get('primary', request.id).status, 'pending');
  assert.deepEqual(core.events('primary', request.id, {}).items.map((event) => event.type), ['request.created']);
  db.exec('DROP TRIGGER block_events');
  assert.equal(core.cancel('primary', request.id).status, 'cancelled');
});

test('an audit write failure rolls back key issuance and request creation', () => {
  const { db, core } = setup();
  db.exec("CREATE TRIGGER block_audit BEFORE INSERT ON audit_events BEGIN SELECT RAISE(ABORT, 'blocked audit'); END");
  assert.throws(() => core.issueClientKey('primary', 'Worker', ['requests:create']), /blocked audit/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM client_keys').get() as { count: number }).count, 0);
  assert.throws(() => core.create('primary', input('audit:atomic')), /blocked audit/);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM requests').get() as { count: number }).count, 0);
  assert.equal((db.prepare('SELECT COUNT(*) AS count FROM request_events').get() as { count: number }).count, 0);
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
  core.deliverySucceeded(before.id, '-100', '101');
  advance(899_999);
  assert.equal(core.decide(beforeJob.callbackRef, '-100', '101', '7', 'approved').request?.status, 'approved');
  advance(2);
  const claim = core.claim('primary', before.id);
  assert.equal(claim.request.status, 'approved');
  assert.equal(core.report('primary', before.id, claim.claimToken, 'failed', 'Target unavailable').executionStatus, 'failed');
  assert.equal(core.get('primary', before.id).status, 'approved');

  const atDeadline = core.create('primary', input('at-deadline')).request;
  const expiringJob = core.dueDeliveries()[0]!;
  core.deliverySucceeded(atDeadline.id, '-100', '102');
  advance(900_000);
  const late = core.decide(expiringJob.callbackRef, '-100', '102', '7', 'approved');
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
  const gateway = new TelegramGateway(core, transport, routes());
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
  core.deliverySucceeded(request.id, '-100', '101');
  const answers: string[] = [];
  const gateway = new TelegramGateway(core, {
    async check() {}, async send() { throw new Error('unexpected send'); }, async poll() { return []; },
    async answer(_id, answer) { answers.push(answer); }, async edit() {},
  }, routes());
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
  core.deliverySucceeded(request.id, '-100', '101');
  const errors: string[] = [];
  const gateway = new TelegramGateway(core, {
    async check() {}, async send() { throw new Error('unexpected send'); }, async poll() { return []; },
    async answer() { throw new Error('Telegram unavailable'); },
    async edit() { throw new Error('Telegram unavailable'); },
  }, routes(), (message) => errors.push(message));
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
  core.deliverySucceeded(request.id, '-100', '101');
  const answers: string[] = [];
  const gateway = new TelegramGateway(core, {
    async check() {}, async send() { throw new Error('unexpected send'); }, async poll() { return []; },
    async answer(_id, answer) { answers.push(answer); }, async edit() {},
  }, routes());
  await gateway.process({ update_id: 1 });
  await gateway.process({ update_id: 2, callback_query: { id: 'missing-message', data: `a:${job.callbackRef}`, from: { id: 7 } } });
  await gateway.process({ update_id: 3, callback_query: { id: 'malformed', data: 'a:payload-and-secrets', from: { id: 7 }, message: { message_id: 101, chat: { id: -100 } } } });
  await gateway.process({ update_id: 4, callback_query: { id: 'unknown-ref', data: `a:${'z'.repeat(16)}`, from: { id: 7 }, message: { message_id: 101, chat: { id: -100 } } } });
  assert.equal(core.get('primary', request.id).status, 'pending');
  assert.deepEqual(answers, ['This button is no longer available.', 'This button is no longer available.', 'This button is no longer available.']);
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
  const gateway = new TelegramGateway(core, transport, routes());
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
  core.deliverySucceeded(request.id, '-100', '101');
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
    async edit(_job, _chatId, _id, status) { edits.push(status); },
  };
  const gateway = new TelegramGateway(core, transport, routes());
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
  assert.deepEqual((await client.listRequests({ status: 'pending', limit: 1 })).items.map((item) => item.id), [request.id]);
  assert.deepEqual((await client.listRequests({ status: 'pending', expiresBefore: new Date(Date.parse(request.expiresAt) + 1).toISOString() })).items.map((item) => item.id), [request.id]);
  assert.deepEqual((await client.listRequests({ status: 'pending', expiresBefore: request.expiresAt })).items, []);
  assert.deepEqual(request.details, []);
  assert.deepEqual(request.metadata, {});
  assert.equal((await client.getRequest(request.id)).status, 'pending');
  await assert.rejects(client.createRequest({ idempotencyKey: 'sdk:one', action: 'maintenance', title: 'Changed',
    description: 'Compact local records', expiresInSeconds: 60 }), (error: unknown) => error instanceof ApiError && error.status === 409 && error.code === 'idempotency_conflict');
  const job = core.dueDeliveries()[0]!;
  core.deliverySucceeded(request.id, '-100', '101');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
  assert.equal((await client.waitForDecision(request.id, { timeoutMs: 100 })).status, 'approved');
  const claim = await client.claim(request.id);
  assert.equal(claim.request.executionStatus, 'claimed');
  await assert.rejects(client.claim(request.id), (error: unknown) => error instanceof ApiError && error.code === 'not_claimable');
  const final = await client.reportResult(request.id, { claimToken: claim.claimToken, status: 'failed', summary: 'Target unavailable' });
  assert.equal(final.executionStatus, 'failed');
  assert.equal(final.resultSummary, 'Target unavailable');
  assert.equal((await client.getRequest(request.id)).executionStatus, 'failed');
  assert.deepEqual((await client.listAuditEvents({ requestId: request.id })).items.map((event) => event.type),
    ['execution.failed', 'execution.claimed', 'request.created']);
  const firstEvents = await client.getRequestEvents(request.id, { limit: 2 });
  assert.deepEqual(firstEvents.items.map((event) => event.type), ['request.created', 'delivery.delivered']);
  assert.equal(typeof firstEvents.nextCursor, 'string');
  assert.deepEqual((await client.getRequestEvents(request.id, { cursor: firstEvents.nextCursor! })).items.map((event) => event.type),
    ['decision.approved', 'execution.claimed', 'execution.failed']);
  const cancellable = await client.createRequest({ idempotencyKey: 'sdk:cancel', action: 'maintenance', title: 'Cancel me',
    description: 'No work required', expiresInSeconds: 60 });
  assert.equal((await client.cancel(cancellable.id)).status, 'cancelled');
  const issued = await client.createClientKey({ label: 'SDK reader', scopes: ['requests:read'] });
  const reader = new ApprovalClient({ baseUrl: 'http://local', apiKey: issued.key, fetch: mockFetch(app) });
  assert.equal((await reader.getRequest(request.id)).id, request.id);
  await assert.rejects(reader.createRequest({ idempotencyKey: 'sdk:denied', action: 'maintenance', title: 'Denied',
    description: 'No work', expiresInSeconds: 60 }), { status: 403, code: 'insufficient_scope' });
  assert.deepEqual((await client.listClientKeys()).items.map((item) => item.id), [issued.id]);
  assert.deepEqual((await client.listAuditEvents({ keyId: issued.id })).items.map((event) => event.type), ['key.issued']);
  assert.equal((await client.revokeClientKey(issued.id)).revokedAt === null, false);
  await assert.rejects(reader.getRequest(request.id), { status: 401, code: 'unauthorized' });
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
  core.deliverySucceeded(a.id, '-100', '101');
  core.decide(job.callbackRef, '-100', '101', '7', 'approved');
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
