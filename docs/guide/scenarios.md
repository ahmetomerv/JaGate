# Scenario guides

These recipes follow JaGate's actual lifecycle: create a request, receive one decision from an allowlisted person in the client's Telegram chat, claim an approval, perform the exact action in the calling application, and report the outcome. JaGate stores the request and its history; it does not run deployment or backup commands. A rejection, cancellation, or expiry ends the attempt without an action.

Start a configured gateway using [Get started locally](/guide/getting-started). Use an issued key belonging to the correct client, and keep the bootstrap key in your administrative environment. The deployment and backup workers below need `requests:create`, `requests:read`, `requests:claim`, and `requests:result`. Add `requests:cancel` only if the worker needs to cancel pending requests. See [Scoped client keys](/API#scoped-client-keys) to issue and revoke keys. Keep client keys and claim tokens out of logs and source control.

## Approve a deployment with the TypeScript client

Suppose a deployment worker wants to deploy one immutable Git commit to production. Put the environment and full commit SHA in the text the approver sees; metadata alone is not displayed in Telegram. Use a stable idempotency key for that target and commit so a repeated submission returns the same request.

The JaGate calls below use the real `ApprovalClient` interface. `deployRevision` is **your application's** function: it must deploy the exact SHA supplied here with the application's own deployment credentials. [Install the client](/guide/typescript) in that application first.

```ts
import { ApprovalClient } from 'jagate';
import { deployRevision } from './deployment.js'; // supplied by your application

const revision = process.env.REVISION_SHA;
const apiKey = process.env.JAGATE_CLIENT_KEY;
if (!revision || !/^[a-f0-9]{40}$/.test(revision) || !apiKey) {
  throw new Error('Set a full REVISION_SHA and JAGATE_CLIENT_KEY');
}

const client = new ApprovalClient({
  baseUrl: process.env.JAGATE_URL ?? 'http://127.0.0.1:3080',
  apiKey,
});
const request = await client.createRequest({
  idempotencyKey: `deploy:production:${revision}`,
  action: 'deploy',
  title: 'Deploy website to production',
  description: `Deploy Git commit ${revision} to production`,
  details: [
    { label: 'Environment', value: 'production' },
    { label: 'Commit', value: revision },
  ],
  expiresInSeconds: 900,
});

console.log(`Approval request: ${request.id}`);
const decision = await client.waitForDecision(request.id, { timeoutMs: 910_000 });
if (decision.status === 'approved') {
  const { claimToken } = await client.claim(request.id);
  // Save the token privately before the external action if crash recovery is needed.
  await deployRevision({ environment: 'production', revision });
  await client.reportResult(request.id, {
    claimToken,
    status: 'succeeded',
    summary: `Production deployed at ${revision}`,
  });
  const timeline = await client.getRequestEvents(request.id);
  console.log(timeline.items.map((event) => event.type));
} else {
  console.log(`No deployment: ${decision.status}`);
}
```

The decision may be `rejected`, `expired`, or `cancelled`; none should deploy. `waitForDecision` can also throw `WaitTimeoutError`: that stops this caller's wait, not the stored request. A competing worker's claim returns 409, so it must not deploy. If deployment fails, report `failed` only after the deployment system confirms it did **not** complete. If the outcome is uncertain, leave the request `claimed` and follow [crash recovery](#recover-a-claimed-request-after-a-crash). The event timeline can show the recorded decision, claim, and reported result, but cannot verify the deployment itself.

## Approve a backup deletion over HTTP

Suppose a backup service intends to remove one immutable snapshot ID. The request describes the repository and snapshot the approver is deciding on. The service must still apply its own retention checks and delete the exact snapshot using its own credentials. These commands call only JaGate; they do not delete any backup.

Set `JAGATE_CLIENT_KEY` to the backup client's issued key. Substitute your real repository and snapshot ID in **every** displayed field and the idempotency key before submitting. If you change the proposal later, use a new idempotency key.

```sh
export JAGATE_URL='http://127.0.0.1:3080'
export JAGATE_CLIENT_KEY='paste-issued-backup-client-key'

curl -sS -i -X POST "$JAGATE_URL/v1/requests" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"delete-backup:archive:snap-20261005-0200","action":"delete-backup","title":"Delete one archive backup","description":"Delete snapshot snap-20261005-0200 from the archive repository","details":[{"label":"Repository","value":"archive"},{"label":"Snapshot ID","value":"snap-20261005-0200"}],"expiresInSeconds":900}'
```

The new request returns HTTP 201 and an `id`; an exact repeat returns HTTP 200 with the same ID. Copy the ID, then wait for the decision in the configured Telegram chat. The caller must check the returned `status` before claiming:

```sh
REQUEST_ID='paste-id-from-create-response'
curl -sS -i "$JAGATE_URL/v1/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

While `status` is `pending`, do nothing. If it is `rejected`, `expired`, or `cancelled`, do not delete the snapshot. A `deliveryStatus` of `retrying` or `failed` is not approval. Once `status` is `approved`, claim it exactly once:

```sh
curl -sS -i -X POST "$JAGATE_URL/v1/requests/$REQUEST_ID/claim" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

The response contains `claimToken` once. Keep it private. The backup service can now verify the same repository and snapshot ID, delete that snapshot through its backup system, and confirm the outcome. Only **after confirmed deletion**, report success to JaGate:

```sh
CLAIM_TOKEN='paste-token-from-claim-response'
curl -sS -i -X POST "$JAGATE_URL/v1/requests/$REQUEST_ID/result" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"claimToken\":\"$CLAIM_TOKEN\",\"status\":\"succeeded\",\"summary\":\"Archive snapshot snap-20261005-0200 deleted\"}"
curl -sS "$JAGATE_URL/v1/requests/$REQUEST_ID/events" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

Report `failed` instead only when the backup system confirms the deletion did not happen. If its response is ambiguous, reconcile the backup system before reporting or attempting another deletion. The final GET shows JaGate's recorded delivery, decision, claim, and result transitions; the timeline does not prove what happened in the backup system.

## Recover a claimed request after a crash

A request with `status: "approved"`, `executionStatus: "claimed"`, and `resultAt: null` has an **unknown external outcome**. JaGate does not release or retry a claim after a crash. Its claim token is returned only once and is absent from request reads and the event timeline.

Set `JAGATE_URL` and `JAGATE_CLIENT_KEY` as in the HTTP recipe above, using an owner key with `requests:read`. The listing is paginated; follow `nextCursor` with the same filters if needed. Copy an ID from the listing, inspect that request and its timeline, then check the target system using the exact action details recorded on the request:

For a large backlog, add `claimedBefore=<UTC ISO 8601 cutoff>` to the listing to show only claims older than your chosen threshold. Keep that cutoff fixed while paging. The [attention queries](/API#requests-needing-attention) also cover failed delivery and approvals nearing expiry.

```sh
curl -sS "$JAGATE_URL/v1/requests?status=approved&executionStatus=claimed&limit=20" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
REQUEST_ID='paste-id-from-list-response'
curl -sS "$JAGATE_URL/v1/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
curl -sS "$JAGATE_URL/v1/requests/$REQUEST_ID/events" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

If the original claim token was saved privately **and** the target system confirms the outcome, use a key for the same client with `requests:result` to report `succeeded` or `failed` through `POST /v1/requests/:id/result`. The backup deletion recipe shows the request shape. A revoked worker key can be replaced without changing request ownership, but the original claim token is still required.

If the token was lost, JaGate cannot return it, reset the claim, or accept a result for that request. Record the verified external outcome in your own incident record. If the action definitely did not happen and you still need it, create a **new** approval request with a new idempotency key. If the external outcome is uncertain, do not repeat the action until you can reconcile it. An exact create retry with the old idempotency key returns the already claimed request.

For response fields, errors, and pagination details, see the [HTTP API](/API). For crash and claim trust boundaries, see [Security and recovery](/guide/security).
