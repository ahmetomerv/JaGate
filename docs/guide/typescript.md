# TypeScript client

Any language can call JaGate's [HTTP API](/API). For Node.js and TypeScript, the repository exports `ApprovalClient`, `ApiError`, `WaitTimeoutError`, and request types from the `jagate` package. The client is a thin HTTP wrapper; installing it does not start a gateway.

JaGate is not published to npm yet. To try this checkout as a local package, build it, then install it by absolute path in your calling application:

```sh
# In the JaGate repository:
npm ci
npm run build

# In your Node application:
npm install /absolute/path/to/your/checkout
```

Point `JAGATE_URL` at a running gateway and provide **that application's own** issued client key as `JAGATE_CLIENT_KEY`. For the full example below, issue it with `requests:create`, `requests:read`, `requests:claim`, and `requests:result`. The server uses that key's client ID to select its Telegram destination and approver allowlist; the caller does not specify them in a request. Keep the configured bootstrap key in a separate administrative environment for [key management](/API#scoped-client-keys).

```ts
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ApprovalClient, WaitTimeoutError } from 'jagate';

const client = new ApprovalClient({
  baseUrl: process.env.JAGATE_URL ?? 'http://127.0.0.1:3080',
  apiKey: process.env.JAGATE_CLIENT_KEY!,
});

const revision = 'example-1';
const request = await client.createRequest({
  idempotencyKey: `local-file:${revision}`,
  action: 'write-local-file',
  title: 'Write a local example file',
  description: `Write one temporary text file for ${revision}`,
  details: [{ label: 'Revision', value: revision }],
  expiresInSeconds: 900,
});

try {
  const decision = await client.waitForDecision(request.id, { timeoutMs: 900_000 });
  if (decision.status !== 'approved') {
    console.log(`No action: ${decision.status}`);
  } else {
    const { claimToken } = await client.claim(request.id);
    const file = join(tmpdir(), `jagate-example-${request.id}.txt`);
    try {
      await writeFile(file, `Approved ${revision}\n`, { flag: 'wx' });
    } catch (error) {
      await client.reportResult(request.id, {
        claimToken, status: 'failed', summary: 'Local file write failed',
      });
      throw error;
    }
    await client.reportResult(request.id, {
      claimToken, status: 'succeeded', summary: 'Local file written',
    });
    console.log(file);
  }
} catch (error) {
  if (error instanceof WaitTimeoutError) {
    console.log('Stopped waiting; the request may still be pending. Check it later.');
  } else {
    throw error;
  }
}
```

The calling app owns the action and its credentials. It should execute the exact parameters it submitted for approval. Use an idempotency key with the target system too, when supported. JaGate can coordinate one claim but cannot guarantee that an external effect executes exactly once.

## Client methods

| Method | Purpose |
| --- | --- |
| `createRequest(input, signal?)` | Create a request, or retrieve an exact idempotent repeat. |
| `listRequests({ status, deliveryStatus, executionStatus, claimedBefore, expiresBefore, limit, cursor }?, signal?)` | Browse this client's requests, newest first; use UTC cutoffs for attention queries. |
| `getRequest(id, signal?)` | Read one request owned by this client. |
| `getRequestEvents(id, { limit, cursor }?, signal?)` | Read the request's recorded gateway events, oldest first. Follow `nextCursor` for later pages. |
| `waitForDecision(id, { timeoutMs, signal? })` | Poll until decision is no longer pending. |
| `cancel(id, signal?)` | Cancel a still-pending request. |
| `claim(id, signal?)` | Atomically claim an approved, unclaimed request. |
| `reportResult(id, { claimToken, status, summary }, signal?)` | Record a claimant-reported outcome. |
| `createClientKey({ label, scopes, expiresAt? }, signal?)` | Use a bootstrap key to issue a scoped key with optional UTC expiry; returns the raw key once. |
| `listClientKeys({ limit, cursor }?, signal?)` | Use a bootstrap key to list issued-key metadata without secrets. |
| `revokeClientKey(id, signal?)` | Use a bootstrap key to revoke an issued key immediately. |
| `listAuditEvents({ limit, cursor, requestId, keyId }?, signal?)` | Use a bootstrap key to read this client's attribution events, newest first. |

To inspect requests without creating or acting on them, issue a separate key with only `requests:read` and construct an `ApprovalClient` with that key. The same client ID can list its requests and inspect an individual request's events:

```ts
const reader = new ApprovalClient({
  baseUrl: process.env.JAGATE_URL ?? 'http://127.0.0.1:3080',
  apiKey: process.env.JAGATE_READ_KEY!,
});
const page = await reader.listRequests({ status: 'approved', limit: 20 });
for (const request of page.items) {
  const timeline = await reader.getRequestEvents(request.id, { limit: 50 });
  console.log(request.id, timeline.items.map((event) => event.type));
}
// If page.nextCursor is non-null, pass it as cursor with the same filters and limit.
// Do the same with timeline.nextCursor to fetch later events for a request.
```

The snippet assumes the `ApprovalClient` import from the example above and a `JAGATE_READ_KEY` environment variable containing the read-only key. Both APIs return `{ items, nextCursor }`, and a null cursor means the last page. Request pages are newest first; events for one request are oldest first. See [List and filter requests](/API#list-and-filter-requests) and [Per-request event timeline](/API#per-request-event-timeline) for filters, event fields, and pagination behavior.

To find requests needing attention, choose a cutoff once and reuse it while paging:

```ts
const now = Date.now();
const oldClaimCutoff = new Date(now - 10 * 60_000).toISOString();
const expiryCutoff = new Date(now + 10 * 60_000).toISOString();
const failedDeliveries = await reader.listRequests({ status: 'pending', deliveryStatus: 'failed' });
const oldClaims = await reader.listRequests({ status: 'approved', executionStatus: 'claimed', claimedBefore: oldClaimCutoff });
const expiring = await reader.listRequests({ status: 'pending', expiresBefore: expiryCutoff });
// If oldClaims.nextCursor exists, pass it with the same filters and oldClaimCutoff.
```

Read-only monitoring can flag these requests. It must not assume an old claim means the caller's action failed; check the target system before any follow-up. See [Requests needing attention](/API#requests-needing-attention).

For a time-limited worker, issue an expiring key with a bootstrap-key client. The expiration is checked on every request. Keep a separate bootstrap key for administration and audit reads:

```ts
const admin = new ApprovalClient({
  baseUrl: process.env.JAGATE_URL ?? 'http://127.0.0.1:3080',
  apiKey: process.env.JAGATE_BOOTSTRAP_KEY!,
});
const expiresAt = new Date(Date.now() + 24 * 60 * 60_000).toISOString();
const worker = await admin.createClientKey({
  label: 'Deployment worker',
  scopes: ['requests:create', 'requests:read', 'requests:claim', 'requests:result'],
  expiresAt,
});
// Save worker.key securely now; listClientKeys only returns its ID and metadata.
const audit = await admin.listAuditEvents({ keyId: worker.id, limit: 20 });
console.log(audit.items.map(({ type, actorKeyId, requestId }) => ({ type, actorKeyId, requestId })));
```

The audit feed records only key IDs for successful creates, claims, reports, issuances, and revocations. It does not contain key secrets or claim tokens. See [Client audit events](/API#client-audit-events) for the event shape and filters.

`waitForDecision` supports `AbortSignal`. `WaitTimeoutError` means only that the local wait ended; it does **not** mean the approval expired. A real server-side expiry is returned as `status: 'expired'`. Non-success HTTP responses throw `ApiError` with `status` and `code` fields. Keep the claim token until result reporting succeeds. If the process crashes after a claim, reconcile the external action before requesting a new approval.

For a ready-made runnable caller from this repository, see [`examples/demo.ts`](https://github.com/ahmetomerv/JaGate/blob/main/examples/demo.ts).
