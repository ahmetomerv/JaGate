import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import Database from 'better-sqlite3';
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
const routes = () => new Map([['primary', { chatId: '-100', approverIds: new Set(['7']) }]]);

class FakeTelegram implements TelegramTransport {
  sent: DeliveryJob[] = [];
  sentChats: string[] = [];
  answers: string[] = [];
  edits: string[] = [];
  failures = 0;
  async check() {}
  async send(job: DeliveryJob, chatId: string) {
    if (this.failures-- > 0) throw new TelegramApiError('transient', 'test failure');
    this.sent.push(job); this.sentChats.push(chatId); return String(100 + this.sent.length);
  }
  async poll(_offset: number, signal: AbortSignal): Promise<Update[]> {
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  }
  async answer(_id: string, text: string) { this.answers.push(text); }
  async edit(_job: DeliveryJob, _chatId: string, _id: string, status: string) { this.edits.push(status); }
}

function callback(job: DeliveryJob, user = 7, chat = -100, message = 101, decision = 'a'): Update {
  return { update_id: 1, callback_query: { id: 'callback', data: `${decision}:${job.callbackRef}`, from: { id: user }, message: { message_id: message, chat: { id: chat } } } };
}

test('creation is durable, idempotent, immutable and conflict aware', () => {
  const { core, db, path } = setup();
  const first = core.create('primary', input());
  assert.equal(first.created, true);
  assert.equal(core.create('primary', { ...input(), metadata: { trace: 'local' } }).request.id, first.request.id);
  assert.throws(() => core.create('primary', { ...input(), title: 'Changed' }), { code: 'idempotency_conflict' });
  assert.equal(first.request.deliveryStatus, 'pending');
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, () => new Date('2026-01-01T12:00:00.000Z'));
  assert.equal(restarted.get('primary', first.request.id).status, 'pending');
  assert.equal(restarted.create('primary', input()).request.id, first.request.id);
});

test('expiry closes pending requests and cancellation prevents decision', () => {
  const { core, advance } = setup();
  const expiring = core.create('primary', input('expire')).request;
  advance(900_000);
  assert.equal(core.get('primary', expiring.id).status, 'expired');
  assert.throws(() => core.claim('primary', expiring.id), { code: 'not_claimable' });
  const cancelled = core.create('primary', input('cancel')).request;
  assert.equal(core.cancel('primary', cancelled.id).status, 'cancelled');
  assert.throws(() => core.cancel('primary', cancelled.id), { code: 'invalid_state' });
});

test('Telegram authorizes user and chat, binds message, and settles only once', async () => {
  const { core } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, routes());
  const request = core.create('primary', input()).request;
  await gateway.deliverDue();
  const job = fake.sent[0]!;
  assert.equal(core.get('primary', request.id).deliveryStatus, 'delivered');
  await gateway.process(callback(job, 8));
  await gateway.process(callback(job, 7, -101));
  await gateway.process(callback(job, 7, -100, 999));
  assert.equal(core.get('primary', request.id).status, 'pending');
  await gateway.process(callback(job));
  await gateway.process(callback(job, 7, -100, 101, 'r'));
  assert.equal(core.get('primary', request.id).status, 'approved');
  assert.equal(core.get('primary', request.id).decidedBy, '7');
  assert.deepEqual(fake.edits, ['approved']);
  assert.match(fake.answers.at(-1)!, /Already approved/);
});

test('each client delivers to its own chat and only its approvers can decide', async () => {
  const { core } = setup();
  const sent: Array<{ job: DeliveryJob; chatId: string }> = [];
  const edits: string[] = [];
  const answers: string[] = [];
  const transport: TelegramTransport = {
    async check() {},
    async send(job, chatId) { sent.push({ job, chatId }); return '101'; },
    async poll() { return []; },
    async answer(_id, message) { answers.push(message); },
    async edit(_job, chatId) { edits.push(chatId); },
  };
  const gateway = new TelegramGateway(core, transport, new Map([
    ['alpha', { chatId: '-100', approverIds: new Set(['7']) }],
    ['beta', { chatId: '-200', approverIds: new Set(['8']) }],
  ]));
  const alpha = core.create('alpha', input('alpha:one')).request;
  const beta = core.create('beta', input('beta:one')).request;
  await gateway.deliverDue();
  const alphaJob = sent.find((item) => item.job.view.clientId === 'alpha')!;
  const betaJob = sent.find((item) => item.job.view.clientId === 'beta')!;
  assert.equal(alphaJob.chatId, '-100');
  assert.equal(betaJob.chatId, '-200');
  assert.match(core.decide(alphaJob.job.callbackRef, '-200', '101', '7', 'approved').outcome, /does not belong/);
  await gateway.process(callback(alphaJob.job, 7, -200));
  await gateway.process(callback(alphaJob.job, 8, -100));
  await gateway.process(callback(betaJob.job, 7, -200));
  assert.equal(core.get('alpha', alpha.id).status, 'pending');
  assert.equal(core.get('beta', beta.id).status, 'pending');
  assert.deepEqual(answers, Array(3).fill('You are not authorized to decide this request.'));
  await gateway.process(callback(alphaJob.job, 7, -100));
  await gateway.process(callback(betaJob.job, 8, -200, 101, 'r'));
  assert.equal(core.get('alpha', alpha.id).status, 'approved');
  assert.equal(core.get('beta', beta.id).status, 'rejected');
  assert.deepEqual(edits, ['-100', '-200']);
});

test('a changed destination requeues pending delivery and invalidates old buttons after restart', async () => {
  const { core, db, path, now } = setup();
  const originalTransport = new FakeTelegram();
  const original = new TelegramGateway(core, originalTransport, new Map([
    ['primary', { chatId: '-100', approverIds: new Set(['7']) }],
  ]));
  const request = core.create('primary', input()).request;
  await original.deliverDue();
  const oldJob = originalTransport.sent[0]!;
  assert.equal(originalTransport.sentChats[0], '-100');
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, now);
  const movedTransport = new FakeTelegram();
  const moved = new TelegramGateway(restarted, movedTransport, new Map([
    ['primary', { chatId: '-200', approverIds: new Set(['8']) }],
  ]));
  try {
    await moved.start();
    const newJob = movedTransport.sent[0]!;
    assert.equal(movedTransport.sentChats[0], '-200');
    assert.notEqual(newJob.callbackRef, oldJob.callbackRef);
    assert.equal(restarted.get('primary', request.id).deliveryStatus, 'delivered');
    await moved.process(callback(oldJob, 7, -100));
    await moved.process(callback(oldJob, 8, -200));
    assert.equal(restarted.get('primary', request.id).status, 'pending');
    await moved.process(callback(newJob, 7, -200));
    assert.equal(restarted.get('primary', request.id).status, 'pending');
    await moved.process(callback(newJob, 8, -200));
    assert.equal(restarted.get('primary', request.id).status, 'approved');
    assert.equal(restarted.get('primary', request.id).decidedBy, '8');
  } finally { await moved.stop(); }
});

test('changing only approvers revokes old users without redelivering pending messages', async () => {
  const { core } = setup();
  const before = new FakeTelegram();
  const request = core.create('primary', input()).request;
  await new TelegramGateway(core, before, routes()).deliverDue();
  const job = before.sent[0]!;
  const after = new FakeTelegram();
  const gateway = new TelegramGateway(core, after, new Map([
    ['primary', { chatId: '-100', approverIds: new Set(['8']) }],
  ]));
  try {
    await gateway.start();
    assert.equal(after.sent.length, 0);
    await gateway.process(callback(job, 7));
    assert.equal(core.get('primary', request.id).status, 'pending');
    await gateway.process(callback(job, 8));
    assert.equal(core.get('primary', request.id).status, 'approved');
    assert.equal(core.get('primary', request.id).decidedBy, '8');
  } finally { await gateway.stop(); }
});

test('an old request for a removed client cannot block configured clients', async () => {
  const { core } = setup();
  const old = core.create('removed', input('removed:one')).request;
  const current = core.create('primary', input('primary:one')).request;
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, routes());
  try {
    await gateway.start();
    assert.equal(core.get('removed', old.id).deliveryStatus, 'failed');
    assert.equal(core.get('primary', current.id).deliveryStatus, 'delivered');
    assert.deepEqual(fake.sentChats, ['-100']);
    assert.equal(gateway.isReady(), true);
  } finally { await gateway.stop(); }
});

test('upgrading an existing database requeues a pending message without a chat binding', async () => {
  const { core, db, path, now } = setup();
  const before = new FakeTelegram();
  const request = core.create('primary', input()).request;
  await new TelegramGateway(core, before, routes()).deliverDue();
  const oldJob = before.sent[0]!;
  db.close();
  const oldSchema = new Database(path);
  oldSchema.exec('ALTER TABLE requests DROP COLUMN delivery_chat_id');
  oldSchema.prepare('DELETE FROM schema_migrations WHERE version = ?').run('002_delivery_chat.sql');
  oldSchema.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  assert.equal((reopened.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get() as { count: number }).count, 2);
  const restarted = new GatewayCore(reopened, now);
  const after = new FakeTelegram();
  const gateway = new TelegramGateway(restarted, after, routes());
  try {
    await gateway.start();
    const newJob = after.sent[0]!;
    assert.notEqual(newJob.callbackRef, oldJob.callbackRef);
    assert.equal(after.sentChats[0], '-100');
    await gateway.process(callback(oldJob));
    assert.equal(restarted.get('primary', request.id).status, 'pending');
    await gateway.process(callback(newJob));
    assert.equal(restarted.get('primary', request.id).status, 'approved');
  } finally { await gateway.stop(); }
});

test('expired and cancelled Telegram buttons cannot decide', async () => {
  const { core, advance } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, routes());
  const expired = core.create('primary', input('expired-tap')).request;
  await gateway.deliverDue();
  advance(900_000);
  await gateway.process(callback(fake.sent[0]!));
  assert.equal(core.get('primary', expired.id).status, 'expired');
  const cancelled = core.create('primary', input('cancelled-tap')).request;
  await gateway.deliverDue();
  core.cancel('primary', cancelled.id);
  await gateway.process(callback(fake.sent[1]!, 7, -100, 102));
  assert.equal(core.get('primary', cancelled.id).status, 'cancelled');
});

test('rejection prevents a claim and records the deciding user', async () => {
  const { core } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, routes());
  const request = core.create('primary', input()).request;
  await gateway.deliverDue();
  await gateway.process(callback(fake.sent[0]!, 7, -100, 101, 'r'));
  assert.equal(core.get('primary', request.id).status, 'rejected');
  assert.equal(core.get('primary', request.id).decidedBy, '7');
  assert.throws(() => core.claim('primary', request.id), { code: 'not_claimable' });
});

test('claim is atomic, final result requires token, crash leaves unknown outcome claimed', async () => {
  const { core, db, path } = setup();
  const fake = new FakeTelegram();
  const gateway = new TelegramGateway(core, fake, routes());
  const request = core.create('primary', input()).request;
  await gateway.deliverDue();
  await gateway.process(callback(fake.sent[0]!));
  const attempts = await Promise.allSettled([Promise.resolve().then(() => core.claim('primary', request.id)), Promise.resolve().then(() => core.claim('primary', request.id))]);
  assert.equal(attempts.filter((x) => x.status === 'fulfilled').length, 1);
  const claim = (attempts.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<ReturnType<typeof core.claim>>).value;
  assert.throws(() => core.report('primary', request.id, 'x'.repeat(43), 'succeeded', 'done'), { code: 'invalid_claim_token' });
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  const restarted = new GatewayCore(reopened, () => new Date('2026-01-01T12:00:00.000Z'));
  assert.equal(restarted.get('primary', request.id).executionStatus, 'claimed');
  assert.throws(() => restarted.claim('primary', request.id), { code: 'not_claimable' });
  assert.equal(restarted.report('primary', request.id, claim.claimToken, 'succeeded', 'Local action completed').executionStatus, 'succeeded');
  assert.throws(() => restarted.report('primary', request.id, claim.claimToken, 'failed', 'again'), { code: 'invalid_state' });
});

test('transient delivery failure retries without falsely reporting delivered', async () => {
  const { core, advance } = setup();
  const fake = new FakeTelegram(); fake.failures = 1;
  const gateway = new TelegramGateway(core, fake, routes());
  const request = core.create('primary', input()).request;
  await gateway.deliverDue();
  assert.equal(core.get('primary', request.id).deliveryStatus, 'retrying');
  assert.equal(core.get('primary', request.id).deliveryAttempts, 1);
  await gateway.deliverDue(); assert.equal(fake.sent.length, 0);
  advance(2000);
  await gateway.deliverDue();
  assert.equal(core.get('primary', request.id).deliveryStatus, 'delivered');
  assert.equal(core.get('primary', request.id).deliveryAttempts, 2);
});

test('delivery stops after five failures and offset survives restart', async () => {
  const { core, advance, db, path } = setup();
  const fake = new FakeTelegram(); fake.failures = 5;
  const gateway = new TelegramGateway(core, fake, routes());
  const request = core.create('primary', input()).request;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await gateway.deliverDue();
    assert.equal(core.get('primary', request.id).deliveryAttempts, attempt);
    advance(2000 * 2 ** (attempt - 1));
  }
  assert.equal(core.get('primary', request.id).deliveryStatus, 'failed');
  await gateway.deliverDue(); assert.equal(fake.sent.length, 0);
  core.saveOffset(21); core.saveOffset(10);
  db.close();
  const reopened = openDatabase(path); dbs.push(reopened);
  assert.equal(new GatewayCore(reopened).getOffset(), 21);
});

test('permanent delivery error is final on the first attempt', async () => {
  const { core } = setup();
  const request = core.create('primary', input()).request;
  const fake = new FakeTelegram();
  fake.send = async () => { throw new TelegramApiError('permanent', 'test'); };
  await new TelegramGateway(core, fake, routes()).deliverDue();
  assert.equal(core.get('primary', request.id).deliveryStatus, 'failed');
  assert.equal(core.get('primary', request.id).deliveryAttempts, 1);
  assert.equal(core.get('primary', request.id).deliveryError, 'test');
});

test('Telegram preflight refuses an existing webhook and poller conflict', async () => {
  const methods: string[] = [];
  const webhookFetch: typeof fetch = async (url) => {
    const method = String(url).split('/').at(-1)!; methods.push(method);
    return Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: 'https://existing.example/callback' } : {} });
  };
  await assert.rejects(new HttpTelegramTransport('testtoken', webhookFetch).check(new Set(['-100'])), /active webhook/);
  assert.deepEqual(methods, ['getMe', 'getWebhookInfo']);
  const conflictFetch: typeof fetch = async (url) => {
    const method = String(url).split('/').at(-1)!;
    return method === 'getUpdates' ? Response.json({ ok: false }, { status: 409 }) : Response.json({ ok: true, result: method === 'getWebhookInfo' ? { url: '' } : {} });
  };
  await assert.rejects(new HttpTelegramTransport('testtoken', conflictFetch).check(new Set(['-100'])), /Another poller/);
});

test('Telegram text is escaped and metadata is not displayed', () => {
  const { core } = setup();
  const req = core.create('primary', { ...input(), title: '<deploy>', metadata: { secret: 'not shown' } }).request;
  const job = core.dueDeliveries()[0]!;
  const rendered = formatMessage(job);
  assert.match(rendered, /&lt;deploy&gt;/);
  assert.doesNotMatch(rendered, /not shown/);
  assert.equal(req.title, '<deploy>');
});

test('HTTP auth, validation, and concurrent claims', async () => {
  const { core } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  assert.equal((await app.inject({ method: 'GET', url: '/v1/requests/test' })).statusCode, 401);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: { ...input(), expiresInSeconds: 1 } })).json().error.code, 'invalid_input');
  const created = await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input() });
  assert.equal(created.statusCode, 201);
  const id = created.json().id as string;
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input() })).statusCode, 200);
  const fake = new FakeTelegram(); const gateway = new TelegramGateway(core, fake, routes());
  await gateway.deliverDue(); await gateway.process(callback(fake.sent[0]!));
  const claims = await Promise.all([app.inject({ method: 'POST', url: `/v1/requests/${id}/claim`, headers, payload: {} }), app.inject({ method: 'POST', url: `/v1/requests/${id}/claim`, headers, payload: {} })]);
  assert.deepEqual(claims.map((x) => x.statusCode).sort(), [200, 409]);
  assert.equal((await app.inject({ method: 'POST', url: `/v1/requests/${id}/result`, headers, payload: { claimToken: claims.find((x) => x.statusCode === 200)!.json().claimToken, status: 'succeeded', summary: 'done' } })).json().executionStatus, 'succeeded');
  await app.close();
});

test('readiness rejects new requests while preserving read access', async () => {
  const { core } = setup();
  const request = core.create('primary', input()).request;
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => false);
  const headers = { authorization: `Bearer ${'a'.repeat(32)}` };
  assert.equal((await app.inject({ method: 'GET', url: '/ready' })).statusCode, 503);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/requests', headers, payload: input('another') })).json().error.code, 'not_ready');
  assert.equal((await app.inject({ method: 'GET', url: `/v1/requests/${request.id}`, headers })).statusCode, 200);
  await app.close();
});

test('SDK waits for decision, distinguishes timeout from expiry, and honors AbortSignal', async () => {
  const { core, advance } = setup();
  const app = createHttpServer(core, new Map([['primary', 'a'.repeat(32)]]), () => true);
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
