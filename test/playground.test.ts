import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';
import { createPlayground } from '../playground/server.js';
import { GatewayCore } from '../src/core.js';
import { createHttpServer } from '../src/http.js';
import { openDatabase } from '../src/storage.js';

const dirs: string[] = [];
const apps: Array<ReturnType<typeof createPlayground>> = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-playground-'));
  dirs.push(dir);
  const path = join(dir, 'playground.sqlite');
  const app = createPlayground({ databasePath: path });
  apps.push(app);
  return { app, path };
}

async function token(app: ReturnType<typeof createPlayground>) {
  const response = await app.inject({ method: 'GET', url: '/api/bootstrap' });
  return (response.json() as { token: string }).token;
}

async function call(app: ReturnType<typeof createPlayground>, session: string, url: string, payload?: unknown) {
  return app.inject({ method: payload === undefined ? 'GET' : 'POST', url,
    headers: { 'x-playground-token': session, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(payload === undefined ? {} : { payload: JSON.stringify(payload) }) });
}

const input = (idempotencyKey = 'playground:test') => ({
  idempotencyKey, action: 'local-test', title: 'Test approval', description: 'Harmless local approval',
  details: [{ label: 'Target', value: 'local' }], metadata: { source: 'test' }, expiresInSeconds: 900,
});

function command(operation: string, extras: Record<string, unknown> = {}) {
  return { mode: 'simulated', clientId: 'website', operation, auth: 'valid', ...extras };
}

test('playground guards commands and exercises HTTP auth, ownership and idempotency', async () => {
  const { app } = setup();
  assert.equal((await app.inject({ method: 'POST', url: '/api/execute', payload: command('create', { payload: input() }) })).statusCode, 403);
  const session = await token(app);
  const first = (await call(app, session, '/api/execute', command('create', { payload: input() }))).json() as { status: number; body: { id: string } };
  assert.equal(first.status, 201);
  const id = first.body.id;
  const listed = (await call(app, session, '/api/execute', command('list', { filters: { deliveryStatus: 'delivered' } }))).json();
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((item: { id: string }) => item.id), [id]);
  assert.deepEqual((await call(app, session, '/api/execute', command('list', { clientId: 'backups' }))).json().body.items, []);
  assert.equal((await call(app, session, '/api/execute', command('list', { auth: 'missing' }))).json().status, 401);
  assert.equal((await call(app, session, '/api/execute', command('create', { payload: input() }))).json().status, 200);
  assert.equal((await call(app, session, '/api/execute', command('create', { payload: { ...input(), title: 'Changed' } }))).json().status, 409);
  assert.equal((await call(app, session, '/api/execute', command('get', { requestId: id, clientId: 'backups' }))).json().status, 404);
  assert.equal((await call(app, session, '/api/execute', command('get', { requestId: id, auth: 'missing' }))).json().status, 401);
  assert.equal((await call(app, session, '/api/execute', command('get', { requestId: id, auth: 'invalid' }))).json().status, 401);
  const timeline = (await call(app, session, '/api/execute', command('events', { requestId: id, eventPage: { limit: 1 } }))).json();
  assert.equal(timeline.status, 200);
  assert.deepEqual(timeline.body.items.map((event: { type: string }) => event.type), ['request.created']);
  assert.equal(timeline.body.nextCursor, '1');
  assert.deepEqual((await call(app, session, '/api/execute', command('events', { requestId: id, eventPage: { cursor: '1' } }))).json().body.items.map((event: { type: string }) => event.type), ['delivery.delivered']);
  assert.equal((await call(app, session, '/api/execute', command('events', { requestId: id, clientId: 'backups' }))).json().status, 404);
  assert.equal((await call(app, session, '/api/execute', command('events', { requestId: id, auth: 'missing' }))).json().status, 401);
});

test('playground forwards attention cutoffs and exposes its simulated clock for fixed queries', async () => {
  const { app } = setup();
  const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as { token: string; simulatedNow: string };
  assert.ok(Number.isFinite(Date.parse(boot.simulatedNow)));
  const created = (await call(app, boot.token, '/api/execute', command('create', { payload: input('attention:playground') }))).json();
  const expiresAt = created.body.expiresAt as string;
  const before = new Date(Date.parse(expiresAt) + 1).toISOString();
  const after = (await call(app, boot.token, '/api/execute', command('list', {
    filters: { status: 'pending', expiresBefore: before },
  }))).json();
  assert.deepEqual(after.body.items.map((item: { id: string }) => item.id), [created.body.id]);
  const excluded = (await call(app, boot.token, '/api/execute', command('list', {
    filters: { status: 'pending', expiresBefore: expiresAt },
  }))).json();
  assert.deepEqual(excluded.body.items, []);
  const advanced = (await call(app, boot.token, '/api/advance-time', { seconds: 1 })).json();
  assert.ok(Date.parse(advanced.now) > Date.parse(boot.simulatedNow));
  const refreshed = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
  assert.ok(Date.parse(refreshed.simulatedNow) > Date.parse(boot.simulatedNow));
});

test('simulated decisions honor approvers, claims and one-time results across restart', async () => {
  const { app, path } = setup();
  const session = await token(app);
  const created = (await call(app, session, '/api/execute', command('create', { payload: input('playground:decision') }))).json();
  const id = created.body.id as string;
  const outsider = (await call(app, session, '/api/decide', { requestId: id, clientId: 'website', decision: 'approve', actor: 'outsider' })).json();
  assert.match(outsider.message, /not authorized/);
  assert.equal(outsider.request.status, 'pending');
  const approved = (await call(app, session, '/api/decide', { requestId: id, clientId: 'website', decision: 'approve', actor: 'allowed' })).json();
  assert.equal(approved.request.status, 'approved');
  const claim = (await call(app, session, '/api/execute', command('claim', { requestId: id }))).json();
  assert.equal(claim.status, 200);
  assert.equal((await call(app, session, '/api/execute', command('claim', { requestId: id }))).json().status, 409);
  assert.equal((await call(app, session, '/api/execute', command('result', { requestId: id,
    payload: { claimToken: 'x'.repeat(43), status: 'succeeded', summary: 'Wrong token' } }))).json().status, 403);
  const result = (await call(app, session, '/api/execute', command('result', { requestId: id,
    payload: { claimToken: claim.body.claimToken, status: 'failed', summary: 'Test failure' } }))).json();
  assert.equal(result.body.executionStatus, 'failed');
  assert.equal((await call(app, session, '/api/execute', command('result', { requestId: id,
    payload: { claimToken: claim.body.claimToken, status: 'failed', summary: 'Again' } }))).json().status, 409);
  await app.close();
  apps.splice(apps.indexOf(app), 1);
  const restarted = createPlayground({ databasePath: path });
  apps.push(restarted);
  const nextSession = await token(restarted);
  assert.equal((await call(restarted, nextSession, '/api/execute', command('get', { requestId: id }))).json().body.executionStatus, 'failed');
  assert.deepEqual((await call(restarted, nextSession, '/api/execute', command('events', { requestId: id }))).json().body.items.map((event: { type: string }) => event.type),
    ['request.created', 'delivery.delivered', 'decision.approved', 'execution.claimed', 'execution.failed']);
});

test('simulated clock expires pending requests and cancellation stops decisions', async () => {
  const { app } = setup();
  const session = await token(app);
  const expiring = (await call(app, session, '/api/execute', command('create', { payload: { ...input('playground:expiry'), expiresInSeconds: 60 } }))).json();
  const id = expiring.body.id as string;
  assert.equal((await call(app, session, '/api/advance-time', { seconds: 61 })).json().expired, 1);
  assert.equal((await call(app, session, '/api/execute', command('get', { requestId: id }))).json().body.status, 'expired');
  assert.equal((await call(app, session, '/api/decide', { requestId: id, clientId: 'website', decision: 'approve', actor: 'allowed' })).json().request.status, 'expired');
  const pending = (await call(app, session, '/api/execute', command('create', { payload: input('playground:cancel') }))).json();
  const pendingId = pending.body.id as string;
  assert.equal((await call(app, session, '/api/execute', command('cancel', { requestId: pendingId }))).json().body.status, 'cancelled');
  assert.equal((await call(app, session, '/api/decide', { requestId: pendingId, clientId: 'website', decision: 'approve', actor: 'allowed' })).json().request.status, 'cancelled');
});

test('playground issues and revokes scoped keys through simulated HTTP routes', async () => {
  const { app } = setup();
  const session = await token(app);
  const created = (await call(app, session, '/api/execute', command('keyCreate', {
    payload: { label: 'Playground reader', scopes: ['requests:read'] },
  }))).json();
  assert.equal(created.status, 201);
  assert.equal(created.body.clientId, 'website');
  const keyId = created.body.id as string;
  const scopedKey = created.body.key as string;
  const listed = (await call(app, session, '/api/execute', command('keyList', { keyPage: { limit: 1 } }))).json();
  assert.equal(listed.status, 200);
  assert.deepEqual(listed.body.items.map((item: { id: string }) => item.id), [keyId]);
  assert.doesNotMatch(JSON.stringify(listed), new RegExp(scopedKey));
  const read = (await call(app, session, '/api/execute', command('list', { auth: 'scoped', scopedKey }))).json();
  assert.equal(read.status, 200);
  assert.equal((await call(app, session, '/api/execute', command('create', { auth: 'scoped', scopedKey,
    payload: input('scoped:denied') }))).json().status, 403);
  assert.equal((await call(app, session, '/api/execute', command('keyList', { auth: 'scoped', scopedKey }))).json().status, 403);
  assert.equal((await call(app, session, '/api/execute', command('keyRevoke', { keyId, clientId: 'backups' }))).json().status, 404);
  assert.equal((await call(app, session, '/api/execute', command('keyRevoke', { keyId }))).json().status, 200);
  assert.equal((await call(app, session, '/api/execute', command('list', { auth: 'scoped', scopedKey }))).json().status, 401);
});

test('playground can inspect key expiry and client audit records in simulation', async () => {
  const { app } = setup();
  const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json() as { token: string; simulatedNow: string };
  const expiresAt = new Date(Date.parse(boot.simulatedNow) + 60_000).toISOString();
  const issued = (await call(app, boot.token, '/api/execute', command('keyCreate', {
    payload: { label: 'Temporary creator', scopes: ['requests:create'], expiresAt },
  }))).json();
  assert.equal(issued.status, 201);
  assert.equal(issued.body.expiresAt, expiresAt);
  const scopedKey = issued.body.key as string;
  const created = (await call(app, boot.token, '/api/execute', command('create', {
    auth: 'scoped', scopedKey, payload: input('playground:audit'),
  }))).json();
  assert.equal(created.status, 201);
  const audit = (await call(app, boot.token, '/api/execute', command('audit', {
    auditPage: { keyId: issued.body.id, limit: 1 },
  }))).json();
  assert.equal(audit.status, 200);
  assert.equal(audit.body.items[0].type, 'request.created');
  assert.equal(audit.body.items[0].actorKeyId, issued.body.id);
  assert.ok(audit.body.nextCursor);
  const older = (await call(app, boot.token, '/api/execute', command('audit', {
    auditPage: { keyId: issued.body.id, limit: 1, cursor: audit.body.nextCursor },
  }))).json();
  assert.equal(older.body.items[0].type, 'key.issued');
  assert.deepEqual((await call(app, boot.token, '/api/execute', command('audit', { clientId: 'backups' }))).json().body.items, []);
  assert.equal((await call(app, boot.token, '/api/execute', command('audit', { auth: 'scoped', scopedKey }))).json().status, 403);
  assert.doesNotMatch(JSON.stringify(audit), new RegExp(scopedKey));
  assert.equal((await call(app, boot.token, '/api/advance-time', { seconds: 60 })).json().expired >= 0, true);
  assert.equal((await call(app, boot.token, '/api/execute', command('create', {
    auth: 'scoped', scopedKey, payload: input('playground:expired-key'),
  }))).json().status, 401);
});

test('live mode keeps client keys in the backend while calling the real HTTP routes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jagate-playground-live-'));
  dirs.push(dir);
  const db = openDatabase(join(dir, 'gateway.sqlite'));
  const key = 'a'.repeat(32);
  const gateway = createHttpServer(new GatewayCore(db), new Map([['website', key]]), () => true);
  try {
    const fetcher: typeof fetch = async (url, init) => {
      const response = await gateway.inject({ method: (init?.method ?? 'GET') as 'GET' | 'POST',
        url: new URL(String(url)).pathname + new URL(String(url)).search, headers: init?.headers as Record<string, string>,
        ...(init?.body ? { payload: String(init.body) } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: { 'content-type': 'application/json' } });
    };
    const app = createPlayground({ databasePath: join(dir, 'playground.sqlite'), liveClientKeys: new Map([['website', key]]), fetcher });
    apps.push(app);
    const boot = (await app.inject({ method: 'GET', url: '/api/bootstrap' })).json();
    assert.deepEqual(boot.liveClients, ['website']);
    assert.equal(JSON.stringify(boot).includes(key), false);
    const created = (await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'create', payload: input('live:test') })).json();
    assert.equal(created.status, 201);
    assert.equal(created.body.clientId, 'website');
    const listed = (await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'list', filters: { status: 'pending', limit: 1 } })).json();
    assert.equal(listed.status, 200);
    assert.deepEqual(listed.body.items.map((item: { id: string }) => item.id), [created.body.id]);
    assert.equal((await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'get', requestId: created.body.id, auth: 'missing' })).json().status, 401);
    const events = (await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'events', requestId: created.body.id })).json();
    assert.equal(events.status, 200);
    assert.deepEqual(events.body.items.map((event: { type: string }) => event.type), ['request.created']);
    const issued = (await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'keyCreate',
      payload: { label: 'Live reader', scopes: ['requests:read'] } })).json();
    assert.equal(issued.status, 201);
    assert.equal((await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'get',
      requestId: created.body.id, auth: 'scoped', scopedKey: issued.body.key })).json().status, 200);
    assert.equal((await call(app, boot.token, '/api/execute', { mode: 'live', clientId: 'website', operation: 'keyRevoke',
      keyId: issued.body.id })).json().status, 200);
  } finally { await gateway.close(); db.close(); }
});
