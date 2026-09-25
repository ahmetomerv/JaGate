import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { openDatabase, type Db } from '../src/storage.js';
import { GatewayCore, type DeliveryJob } from '../src/core.js';
import { createHttpServer } from '../src/http.js';
import { ApprovalClient, WaitTimeoutError } from '../src/client.js';
import { TelegramGateway, TelegramApiError, HttpTelegramTransport, type TelegramTransport, type Update, formatMessage } from '../src/telegram.js';
import type { CreateInput } from '../src/model.js';

const dirs: string[] = [];
const dbs: Db[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) if (db.open) db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-test-'));
  dirs.push(dir);
  const path = join(dir, 'db.sqlite');
  const db = openDatabase(path);
  dbs.push(db);
  let time = new Date('2026-01-01T12:00:00.000Z');
  const core = new GatewayCore(db, () => time);
  return { path, db, core, advance: (ms: number) => { time = new Date(time.getTime() + ms); }, now: () => time };
}
const input = (key = 'deploy:abc'): CreateInput => ({
  idempotencyKey: key, action: 'deploy', title: 'Deploy website', description: 'Deploy revision abc',
  details: [{ label: 'Environment', value: 'production' }], expiresInSeconds: 900, metadata: { trace: 'local' },
});

class FakeTelegram implements TelegramTransport {
  sent: DeliveryJob[] = [];
  answers: string[] = [];
  edits: string[] = [];
  failures = 0;
  async check() {}
  async send(job: DeliveryJob) {
    if (this.failures-- > 0) throw new TelegramApiError('transient', 'test failure');
    this.sent.push(job); return String(100 + this.sent.length);
  }
  async poll(_offset: number, signal: AbortSignal): Promise<Update[]> {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  }
  async answer(_id: string, text: string) { this.answers.push(text); }
  async edit(_job: DeliveryJob, _id: string, status: string) { this.edits.push(status); }
}

function callback(job: DeliveryJob, user = 7, chat = -100, message = 101, decision = 'a'): Update {
  return { update_id: 1, callback_query: { id: 'callback', data: `${decision}:${job.callbackRef}`, from: { id: user }, message: { message_id: message, chat: { id: chat } } } };
}

test('creation is durable, idempotent, immutable and conflict aware', () => {
  const { core, db, path } = setup();
  const first = core.create(input());
  assert.equal(first.created, true);
  assert.equal(core.create({ ...input(), metadata: { trace: 'local' } }).request.id, first.request.id);
  assert.throws(() => core.create({ ...input(), title: 'Changed' }), { code: 'idempotency_conflict' });
  assert.equal(first.request.deliveryStatus, 'pending');
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, () => new Date('2026-01-01T12:00:00.000Z'));
  assert.equal(restarted.get(first.request.id).status, 'pending');
  assert.equal(restarted.create(input()).request.id, first.request.id);
});

test('expiry closes pending requests and cancellation prevents decision', () => {
  const { core, advance } = setup();
  const expiring = core.create(input('expire')).request;
  advance(900_000);
  assert.equal(core.get(expiring.id).status, 'expired');
  assert.throws(() => core.claim(expiring.id), { code: 'not_claimable' });
  const cancelled = core.create(input('cancel')).request;
  assert.equal(core.cancel(cancelled.id).status, 'cancelled');
  assert.throws(() => core.cancel(cancelled.id), { code: 'invalid_state' });
});

test('Telegram authorizes user and chat, binds message, and settles only once', async () => {
  const { core } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  const request = core.create(input()).request;
  await gateway.deliverDue();
  const job = fake.sent[0]!;
  assert.equal(core.get(request.id).deliveryStatus, 'delivered');
  await gateway.process(callback(job, 8));
  await gateway.process(callback(job, 7, -101));
  await gateway.process(callback(job, 7, -100, 999));
  assert.equal(core.get(request.id).status, 'pending');
  await gateway.process(callback(job));
  await gateway.process(callback(job, 7, -100, 101, 'r'));
  assert.equal(core.get(request.id).status, 'approved');
  assert.equal(core.get(request.id).decidedBy, '7');
  assert.deepEqual(fake.edits, ['approved']);
  assert.match(fake.answers.at(-1)!, /Already approved/);
});

test('expired and cancelled Telegram buttons cannot decide', async () => {
  const { core, advance } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  const expired = core.create(input('expired-tap')).request;
  await gateway.deliverDue();
  advance(900_000);
  await gateway.process(callback(fake.sent[0]!));
  assert.equal(core.get(expired.id).status, 'expired');
  const cancelled = core.create(input('cancelled-tap')).request;
  await gateway.deliverDue();
  core.cancel(cancelled.id);
  await gateway.process(callback(fake.sent[1]!, 7, -100, 102));
  assert.equal(core.get(cancelled.id).status, 'cancelled');
});

test('rejection prevents a claim and records the deciding user', async () => {
  const { core } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  const request = core.create(input()).request;
  await gateway.deliverDue();
  await gateway.process(callback(fake.sent[0]!, 7, -100, 101, 'r'));
  assert.equal(core.get(request.id).status, 'rejected');
  assert.equal(core.get(request.id).decidedBy, '7');
  assert.throws(() => core.claim(request.id), { code: 'not_claimable' });
});

test('claim is atomic, final result requires token, crash leaves unknown outcome claimed', async () => {
  const { core, db, path } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  const request = core.create(input()).request;
  await gateway.deliverDue();
  await gateway.process(callback(fake.sent[0]!));
  const attempts = await Promise.allSettled([Promise.resolve().then(() => core.claim(request.id)), Promise.resolve().then(() => core.claim(request.id))]);
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  const claim = (attempts.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<ReturnType<typeof core.claim>>).value;
  assert.throws(() => core.report(request.id, 'x'.repeat(43), 'succeeded', 'done'), { code: 'invalid_claim_token' });
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, () => new Date('2026-01-01T12:00:00.000Z'));
  assert.equal(restarted.get(request.id).executionStatus, 'claimed');
  assert.throws(() => restarted.claim(request.id), { code: 'not_claimable' });
  assert.equal(restarted.report(request.id, claim.claimToken, 'succeeded', 'Local action completed').executionStatus, 'succeeded');
  assert.throws(() => restarted.report(request.id, claim.claimToken, 'failed', 'again'), { code: 'invalid_state' });
});

test('transient delivery failure retries without falsely reporting delivered', async () => {
  const { core, advance } = setup();
  const fake = new FakeTelegram(); fake.failures = 1;
  const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  const request = core.create(input()).request;
  await gateway.deliverDue();
  assert.equal(core.get(request.id).deliveryStatus, 'retrying');
  assert.equal(core.get(request.id).deliveryAttempts, 1);
  await gateway.deliverDue(); assert.equal(fake.sent.length, 0);
  advance(2000);
  await gateway.deliverDue();
  assert.equal(core.get(request.id).deliveryStatus, 'delivered');
  assert.equal(core.get(request.id).deliveryAttempts, 2);
});

test('delivery stops after five failures and offset survives restart', async () => {
  const { core, advance, db, path } = setup();
  const fake = new FakeTelegram(); fake.failures = 5;
  const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  const request = core.create(input()).request;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await gateway.deliverDue();
    assert.equal(core.get(request.id).deliveryAttempts, attempt);
    advance(2000 * 2 ** (attempt - 1));
  }
  assert.equal(core.get(request.id).deliveryStatus, 'failed');
  await gateway.deliverDue(); assert.equal(fake.sent.length, 0);
  core.saveOffset(21); core.saveOffset(10);
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  assert.equal(new GatewayCore(reopened).getOffset(), 21);
});

test('permanent delivery error is final on the first attempt', async () => {
  const { core } = setup();
  const request = core.create(input()).request;
  const fake = new FakeTelegram();
  fake.send = async () => { throw new TelegramApiError('permanent', 'test'); };
  await new TelegramGateway(core, fake, '-100', new Set(['7'])).deliverDue();
  assert.equal(core.get(request.id).deliveryStatus, 'failed');
  assert.equal(core.get(request.id).deliveryAttempts, 1);
  assert.equal(core.get(request.id).deliveryError, 'test');
});

test('Telegram preflight refuses an existing webhook and poller conflict', async () => {
  const methods: string[] = [];
  const webhookFetch: typeof fetch = async (url) => {
    const method = String(url).split('/').at(-1)!; methods.push(method);
    return Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: 'https://existing.example/callback' } : {} });
  };
  await assert.rejects(new HttpTelegramTransport('testtoken', '-100', webhookFetch).check(), /active webhook/);
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo']);
  const conflictFetch: typeof fetch = async (url) => {
    const method = String(url).split('/').at(-1)!;
    return method === 'getUpdates' ? Response.json({ ok: false }, { status: 409 }) : Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: '' } : {} });
  };
  await assert.rejects(new HttpTelegramTransport('testtoken', '-100', conflictFetch).check(), /Another poller/);
});

test('Telegram text is escaped and metadata is not displayed', () => {
  const { core } = setup();
  const req = core.create({ ...input(), title: '<deploy>', metadata: { secret: 'not shown' } }).request;
  const job = core.dueDeliveries()[0]!;
  const rendered = formatMessage(job);
  assert.match(rendered, /&lt;deploy&gt;/);
  assert.doesNotMatch(rendered, /not shown/);
  assert.equal(req.title, '<deploy>');
});

test('HTTP auth, validation, and concurrent claims', async () => {
  const { core } = setup();
  const app = createHttpServer(core, 'a'.repeat(32), () => true);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  assert.equal((await app.inject({ method: 'GET', url: '/v1/requests/test' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: { ...input(), expiresInSeconds: 1 } })).json().error.code, 'invalid_input');
  const created = await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input() });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input() })).statusCode, 200);
  const fake = new FakeTelegram(); const gateway = new TelegramGateway(core, fake, '-100', new Set(['7']));
  await gateway.deliverDue(); await gateway.process(callback(fake.sent[0]!));
  const claims = await Promise.all([app.inject({ method: 'POST', url: `/v1/requests/${id}/claim`, headers, payload: {} }), app.inject({ method: 'POST', url: `/v1/requests/${id}/claim`, headers, payload: {} })]);
  assert.deepEqual(claims.map((x) => x.statusCode).sort(), [200, 409]);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/result`, headers, payload: { claimToken: claims.find((x) => x.statusCode === 200)!.json().claimToken, status: 'succeeded', summary: 'done' } })).json().executionStatus, 'succeeded');
  await app.close();
});

test('readiness rejects new requests while preserving read access', async () => {
  const { core } = setup();
  const request = core.create(input()).request;
  const app = createHttpServer(core, 'a'.repeat(32), () => false);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input('another') })).json().error.code, 'not_ready');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${request.id}`, headers })).statusCode, 200);
  await app.close();
});

test('SDK waits for decision, distinguishes timeout from expiry, and honors AbortSignal', async () => {
  const { core, advance } = setup();
  const app = createHttpServer(core, 'a'.repeat(32), () => true);
  const fetcher: typeof fetch = async (url, init) => {
    const u = new URL(String(url));
    const injected = await app.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST', url: u.pathname, headers: init?.headers as Record<string, string>, ...(init?.body ? { payload: String(init.body) } : {}) });
    return new Response(injected.body, { status: injected.statusCode, headers: { 'content-type': 'application/json' } });
  };
  const client = new ApprovalClient({ baseUrl: 'http://local', apiKey: 'a'.repeat(32), fetch: fetcher, pollIntervalMs: 10 });
  const request = await client.createRequest(input());
  await assert.rejects(client.waitForDecision(request.id, { timeoutMs: 25 }), WaitTimeoutError);
  const controller = new AbortController(); controller.abort(new Error('stopped'));
  await assert.rejects(client.waitForDecision(request.id, { timeoutMs: 1000, signal: controller.signal }), /stopped/);
  const later = new AbortController();
  setTimeout(() => later.abort(new Error('cancelled while waiting')), 10);
  await assert.rejects(client.waitForDecision(request.id, { timeoutMs: 1000, signal: later.signal }), /cancelled while waiting/);
  advance(900_000);
  assert.equal((await client.waitForDecision(request.id, { timeoutMs: 1000 })).status, 'expired');
  await app.close();
});
