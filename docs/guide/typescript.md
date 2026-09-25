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

Point `JAGATE_URL` at a running gateway and provide **that application's own** client key as `JAGATE_CLIENT_KEY`.

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
| `getRequest(id, signal?)` | Read one request owned by this client. |
| `waitForDecision(id, { timeoutMs, signal? })` | Poll until decision is no longer pending. |
| `cancel(id, signal?)` | Cancel a still-pending request. |
| `claim(id, signal?)` | Atomically claim an approved, unclaimed request. |
| `reportResult(id, { claimToken, status, summary }, signal?)` | Record a claimant-reported outcome. |

`waitForDecision` supports `AbortSignal`. `WaitTimeoutError` means only that the local wait ended; it does **not** mean the approval expired. A real server-side expiry is returned as `status: 'expired'`. Non-success HTTP responses throw `ApiError` with `status` and `code` fields. Keep the claim token until result reporting succeeds. If the process crashes after a claim, reconcile the external action before requesting a new approval.

For a ready-made runnable caller from this repository, see [`examples/demo.ts`](https://github.com/ahmetomerv/JaGate/blob/main/examples/demo.ts).
