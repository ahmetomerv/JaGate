import type { ConsoleApi } from '../console/src/api.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  classifyKey,
  consoleApiMethodNames,
  createConsoleApi,
} from '../console/src/api.js';
import { cutoffIso, isUnknownOutcome, keyStatus, shouldOfferCancel } from '../console/src/policy.js';
import { consoleKeyScopes } from '../console/src/scopes.js';
import { createConsoleSession } from '../console/src/session.js';
import { ApiError } from '../src/client.js';
import { clientKeyScopes } from '../src/model.js';

test('console scopes stay aligned with the gateway', () => {
  assert.deepEqual(consoleKeyScopes, clientKeyScopes);
});

test('cancel is offered only for a pending request the session may still cancel', () => {
  assert.equal(shouldOfferCancel('pending', false), true);
  assert.equal(shouldOfferCancel('pending', true), false);
  assert.equal(shouldOfferCancel('approved', false), false);
  assert.equal(shouldOfferCancel('rejected', false), false);
});

test('a claimed approval with no result stays an unknown outcome', () => {
  assert.equal(isUnknownOutcome({
    status: 'approved',
    executionStatus: 'claimed',
    resultAt: null,
  }), true);
  assert.equal(isUnknownOutcome({
    status: 'approved',
    executionStatus: 'succeeded',
    resultAt: '2026-01-01T00:00:00.000Z',
  }), false);
  assert.equal(isUnknownOutcome({
    status: 'approved',
    executionStatus: 'unclaimed',
    resultAt: null,
  }), false);
});

test('cutoff timestamps move backward for claims and forward for expiry', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  assert.equal(cutoffIso(now, 15 * 60 * 1000, 'past'), '2026-01-01T11:45:00.000Z');
  assert.equal(cutoffIso(now, 15 * 60 * 1000, 'future'), '2026-01-01T12:15:00.000Z');
});

test('issued key status treats revoke as terminal and expiry as elapsed', () => {
  const now = new Date('2026-01-01T12:00:00.000Z');
  assert.equal(keyStatus({ revokedAt: now.toISOString(), expiresAt: null }, now), 'revoked');
  assert.equal(keyStatus({
    revokedAt: null,
    expiresAt: '2026-01-01T11:00:00.000Z',
  }, now), 'expired');
  assert.equal(keyStatus({ revokedAt: null, expiresAt: null }, now), 'active');
});

test('the session keeps one key in memory and drops it on sign-out', () => {
  const session = createConsoleSession();
  session.signIn('bootstrap-key', 'bootstrap');
  session.noteClient('website');
  session.holdSecret('issued-once');
  assert.equal(session.state.key, 'bootstrap-key');
  assert.equal(session.readSecret(), 'issued-once');

  const controller = session.openScope();
  session.signOut();
  assert.equal(session.state.key, null);
  assert.equal(session.state.role, null);
  assert.equal(session.state.clientId, null);
  assert.equal(session.readSecret(), null);
  assert.equal(controller.signal.aborted, true);
});

test('closing the issued-key dialog discards the secret without signing out', () => {
  const session = createConsoleSession();
  session.signIn('bootstrap-key', 'bootstrap');
  session.holdSecret('jgk_secret');
  session.discardSecret();
  assert.equal(session.readSecret(), null);
  assert.equal(session.state.key, 'bootstrap-key');
});

test('signing in replaces the previous key and secret', () => {
  const session = createConsoleSession();
  session.signIn('bootstrap-key', 'bootstrap');
  session.holdSecret('jgk_secret');
  session.denyCancel();
  session.signIn('issued-key', 'issued');
  assert.equal(session.state.key, 'issued-key');
  assert.equal(session.state.role, 'issued');
  assert.equal(session.state.cancelDenied, false);
  assert.equal(session.readSecret(), null);
});

test('the console API exposes read, cancel, keys, and audit only', () => {
  let unauthorized = 0;
  const api = createConsoleApi({
    baseUrl: 'http://127.0.0.1',
    getKey: () => 'test-key',
    onUnauthorized: () => {
      unauthorized += 1;
    },
  });
  assert.deepEqual(Object.keys(api).sort(), [...consoleApiMethodNames].sort());
  for (const method of ['createRequest', 'claim', 'reportResult', 'waitForDecision'] as const)
    assert.equal(method in api, false);
  assert.equal(unauthorized, 0);
});

test('a 401 clears the session through the unauthorized callback', async () => {
  const session = createConsoleSession();
  session.signIn('stale-key', 'issued');
  const api = createConsoleApi({
    baseUrl: 'http://127.0.0.1',
    getKey: () => session.state.key ?? '',
    fetch: async () => new Response(JSON.stringify({
      error: { code: 'unauthorized', message: 'valid client bearer key required' },
    }), { status: 401, headers: { 'content-type': 'application/json' } }),
    onUnauthorized: () => session.signOut(),
  });
  await assert.rejects(
    () => api.listRequests(),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(session.state.key, null);
});

test('classifying a key uses the client-keys response and does not store it', async () => {
  assert.equal(await classifyKey(async () => ({ items: [], nextCursor: null })), 'bootstrap');
  await assert.rejects(
    () => classifyKey(async () => {
      throw new ApiError(401, 'unauthorized', 'valid client bearer key required');
    }),
    (error: unknown) => error instanceof ApiError && error.status === 401,
  );
  assert.equal(
    await classifyKey(async () => {
      throw new ApiError(403, 'insufficient_scope', 'bootstrap client key required');
    }),
    'issued',
  );
});

test('list and detail calls forward the bearer key and leave claim routes unused', async () => {
  const seen: string[] = [];
  const api: ConsoleApi = createConsoleApi({
    baseUrl: 'http://127.0.0.1:3080',
    getKey: () => 'memory-key',
    fetch: async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      seen.push(`${init?.method ?? 'GET'} ${url}`);
      const header = new Headers(init?.headers).get('authorization');
      assert.equal(header, 'Bearer memory-key');
      assert.equal(url.includes('memory-key'), false);
      return new Response(JSON.stringify({ items: [], nextCursor: null }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
    onUnauthorized: () => {
      throw new Error('unexpected sign-out');
    },
  });
  await api.listRequests({ status: 'pending', limit: 20 });
  await api.listClientKeys({ limit: 1 });
  assert.deepEqual(seen, [
    'GET http://127.0.0.1:3080/v1/requests?status=pending&limit=20',
    'GET http://127.0.0.1:3080/v1/client-keys?limit=1',
  ]);
});
