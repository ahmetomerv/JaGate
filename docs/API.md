# HTTP API v1

Base URL: `http://127.0.0.1:3080` by default. All `/v1` routes require `Authorization: Bearer <CLIENT_KEY>`, using a configured bootstrap key or an issued key for one client ID. Send JSON with `Content-Type: application/json` for POST. Dates are UTC ISO 8601 strings. `/health` and `/ready` are unauthenticated and contain no secrets. A client ID is derived from the bearer key; callers cannot choose or change it in the request body.

Set `JAGATE_CLIENT_KEY` to **your application's own** key before using the examples. A single gateway can serve multiple clients, but each key sees only its owner's requests. The gateway never executes the action described in a request.

The server routes each client's approval message to its configured Telegram chat and permits only that client's allowlisted numeric approvers to decide there. HTTP callers cannot choose a chat or approver in a request body. See [Configuration and clients](/guide/configuration).

## Scoped client keys

Each `CLIENT_KEYS` environment entry is a **bootstrap key** for that client. It can use all request routes and manage issued keys for its own client. Keep it in the gateway's local environment or an administrative tool; give applications issued keys with only the permissions they need. The gateway stores issued-key hashes, never their raw values. Bootstrap keys are changed in `CLIENT_KEYS` and loaded on restart; they are not listed or revoked through the API.

Create an issued key with `POST /v1/client-keys` using the bootstrap key. In this example, `JAGATE_CLIENT_KEY` must hold that client's bootstrap key:

```sh
curl -sS -X POST http://127.0.0.1:3080/v1/client-keys \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"label":"Website approval worker","scopes":["requests:create","requests:read","requests:claim","requests:result"]}'
```

The response is HTTP 201 and includes `id`, `clientId`, `label`, `scopes`, `createdAt`, `revokedAt: null`, and the generated `key`. **The raw `key` is returned only on creation.** Store it privately; listing or revoking a key never returns it. Labels are 1–80 characters after trimming, without control characters. `scopes` must be a nonempty, duplicate-free array of these values:

| Scope | Routes allowed |
| --- | --- |
| `requests:create` | `POST /v1/requests` |
| `requests:read` | `GET /v1/requests`, `GET /v1/requests/:id`, `GET /v1/requests/:id/events` |
| `requests:cancel` | `POST /v1/requests/:id/cancel` |
| `requests:claim` | `POST /v1/requests/:id/claim` |
| `requests:result` | `POST /v1/requests/:id/result` |

Scopes authorize routes; normal request state checks and the one-time claim token still apply. An issued key cannot create, list, or revoke client keys. A missing or revoked key returns 401 `unauthorized`; a valid key lacking a route's scope returns 403 `insufficient_scope`. A key from another client still gets 404 `not_found` for a request or issued-key ID it does not own. Issued keys work only while their client ID remains configured in `CLIENT_KEYS`.

The example worker can create a request, read its decision, claim an approval, and report an outcome. Give a monitoring tool only `requests:read` to let it list requests and view timelines. Add `requests:cancel` only if a caller must cancel pending requests. A key with `requests:create` alone cannot poll a decision; `requests:result` alone cannot claim one.

`GET /v1/client-keys?limit=20` lists this client's issued keys newest first, including revoked keys. It returns `{ "items": [/* key metadata, never raw keys */], "nextCursor": null }`. `limit` is 1–100 (default 20); pass a non-null `nextCursor` as `cursor` with the same limit for later pages. Revoke with `POST /v1/client-keys/:id/revoke` and `{}`. The response is the key metadata with `revokedAt`; repeated revocation returns the same metadata. Revocation blocks the next request immediately and persists across restarts. Neither action affects requests already owned by the client.

```sh
curl -sS -X POST "http://127.0.0.1:3080/v1/client-keys/$KEY_ID/revoke" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

The TypeScript client exposes `createClientKey`, `listClientKeys`, and `revokeClientKey` for bootstrap-key administration.

## Create a request

`POST /v1/requests` returns 201 for a new request and 200 for an exact idempotent repeat by the same client.

```sh
curl -sS -X POST http://127.0.0.1:3080/v1/requests \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"deploy:abc123","action":"deploy","title":"Deploy website","description":"Deploy revision abc123 to production","details":[{"label":"Revision","value":"abc123"}],"expiresInSeconds":900,"metadata":{"ticket":"OPS-42"}}'
```

```json
{
  "idempotencyKey": "deploy:abc123",
  "action": "deploy",
  "title": "Deploy website",
  "description": "Deploy revision abc123 to production",
  "details": [{ "label": "Revision", "value": "abc123" }],
  "expiresInSeconds": 900,
  "metadata": { "ticket": "OPS-42" }
}
```

`idempotencyKey`: 1–128 ASCII letters, digits, `.`, `_`, `:`, `=`, or `-`, beginning with a letter or digit. Its identity is stored for the lifetime of the database within that client ID. Different clients can use the same key independently. `action`: 1–64 lowercase letters, digits, `.`, `_`, or `-`, beginning with a letter. `title`: 1–100 characters. `description`: 1–1000 characters. `details`: at most 10 pairs; labels 1–40 and values 1–160 characters. `expiresInSeconds`: integer 60–86400. `metadata`: optional JSON object, at most 2048 serialized bytes; it is returned to the owning client but not shown in Telegram. Display text is also limited to fit Telegram after HTML escaping. Text fields cannot contain control characters. Unknown fields are rejected. Omitted `details` and `metadata` become `[]` and `{}`. Idempotency compares canonical validated content, including expiry duration, details, and metadata; changing any of it under the same client and key is a conflict.

Example response (fields also returned by `GET`, `cancel`, and `result`):

```json
{
  "id": "123e4567-e89b-42d3-a456-426614174000",
  "clientId": "website",
  "action": "deploy",
  "title": "Deploy website",
  "description": "Deploy revision abc123 to production",
  "details": [{ "label": "Revision", "value": "abc123" }],
  "metadata": { "ticket": "OPS-42" },
  "createdAt": "2026-09-24T12:00:00.000Z",
  "expiresAt": "2026-09-24T12:15:00.000Z",
  "status": "pending",
  "decidedBy": null,
  "decidedAt": null,
  "executionStatus": "unclaimed",
  "claimedAt": null,
  "resultSummary": null,
  "resultAt": null,
  "deliveryStatus": "pending",
  "deliveryAttempts": 0,
  "deliveryError": null
}
```

The client ID, action, title, description, details, metadata, creation time, and expiry time never change after creation. `decidedBy` is the numeric Telegram user ID as a string when decided by an approver. Expiry and cancellation have no deciding user.

## List and filter requests

`GET /v1/requests` returns only requests owned by the bearer key's client. Results are ordered by `createdAt` descending, then `id` descending. All filters are optional and combine with AND:

| Query parameter | Values | Default |
| --- | --- | --- |
| `status` | `pending`, `approved`, `rejected`, `expired`, `cancelled` | any |
| `deliveryStatus` | `pending`, `retrying`, `delivered`, `failed` | any |
| `executionStatus` | `unclaimed`, `claimed`, `succeeded`, `failed` | any |
| `claimedBefore` | UTC ISO 8601 timestamp; `claimedAt` strictly earlier | any |
| `expiresBefore` | UTC ISO 8601 timestamp; `expiresAt` strictly earlier | any |
| `limit` | integer from 1 to 100 | 20 |
| `cursor` | opaque `nextCursor` from the previous page | first page |

```sh
curl -sS 'http://127.0.0.1:3080/v1/requests?status=pending&limit=20' \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

The response is `{ "items": [/* complete request objects */], "nextCursor": null }`. When `nextCursor` is a string, send it as the `cursor` parameter with the **same filters and limit** to fetch the next page. A null cursor means there are no more matching requests. The cursor marks the last request on the page; newly created requests do not shift later pages. Status can change between page requests, so repeat from the first page when you need a fresh view. An empty result returns `items: []` and `nextCursor: null`. Unknown or invalid query parameters return 400 `invalid_input`.

The TypeScript client exposes `listRequests({ status, deliveryStatus, executionStatus, claimedBefore, expiresBefore, limit, cursor })` with `ListRequestsQuery` and `ListRequestsPage` types. Timestamps must have a `Z` suffix and at most three fractional second digits; accepted values are normalized to millisecond precision before comparison. Requests without a claim cannot match `claimedBefore`.

### Requests needing attention

These are ordinary read-only list queries. Use a key with `requests:read` for the relevant client. Set `JAGATE_URL`, `JAGATE_CLIENT_KEY`, and a fixed UTC cutoff before running them:

```sh
# Pending approvals whose Telegram delivery failed.
curl -sS "$JAGATE_URL/v1/requests?status=pending&deliveryStatus=failed&limit=20" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"

# Claims older than the cutoff whose caller has not reported an outcome.
curl -sS "$JAGATE_URL/v1/requests?status=approved&executionStatus=claimed&claimedBefore=$CUTOFF_UTC&limit=20" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"

# Pending approvals expiring before the cutoff.
curl -sS "$JAGATE_URL/v1/requests?status=pending&expiresBefore=$CUTOFF_UTC&limit=20" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

For example, set `CUTOFF_UTC=2026-10-05T12:00:00.000Z` (URL-encode it if using a different timestamp format). A delivery failure is terminal for that delivery attempt, but the request remains pending until cancelled or expired. Listing calls expire elapsed pending requests first, so the pending filters exclude already expired requests. Reuse the **same cutoff and filters** with `nextCursor` for later pages; choose a new cutoff and restart from page one for a fresh scan. Inspect a request and its [event timeline](#per-request-event-timeline) before taking action. A claimed request may have already caused an external effect: reconcile that system before reporting or starting a new approval. JaGate does not reset claims or retry actions from these queries.

## Per-request event timeline

`GET /v1/requests/:id/events` returns recorded gateway state changes for one request owned by the bearer key's client. Events are ordered oldest first by a per-request `sequence` number. An unknown ID or another client's ID returns 404.

```sh
curl -sS "http://127.0.0.1:3080/v1/requests/$REQUEST_ID/events?limit=50" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

```json
{
  "items": [
    { "sequence": 1, "type": "request.created", "occurredAt": "2026-09-24T12:00:00.000Z", "actorId": null, "attempt": null },
    { "sequence": 2, "type": "delivery.delivered", "occurredAt": "2026-09-24T12:00:01.000Z", "actorId": null, "attempt": 1 },
    { "sequence": 3, "type": "decision.approved", "occurredAt": "2026-09-24T12:01:00.000Z", "actorId": "7", "attempt": null }
  ],
  "nextCursor": null
}
```

`limit` is 1–100 (default 50). When `nextCursor` is non-null, pass it as `cursor` with the same request ID to fetch later events. An empty page returns `items: []` and `nextCursor: null`. Invalid or unknown query parameters return 400 `invalid_input`.

Types include `request.created`, `delivery.delivered`, `delivery.retry_scheduled`, `delivery.failed`, `delivery.requeued`, `decision.approved`, `decision.rejected`, `decision.expired`, `decision.cancelled`, `execution.claimed`, `execution.succeeded`, and `execution.failed`. A delivery event's `attempt` is its numbered send attempt. Decision events from Telegram include the numeric approver ID in `actorId`; other events have `actorId: null`. An event is appended only when its state transition succeeds, in the same database transaction. Idempotent creates, repeated callbacks, and rejected claims or results do not add events. The timeline is a gateway record: a reported execution result is supplied by the caller, not independently verified by JaGate.

Events are recorded from the time this feature is installed. Earlier state changes are not reconstructed, so an older request may have an empty timeline until its next transition. Events omit request content, delivery errors, chat and message IDs, callback references, claim IDs, claim tokens, and result summaries. Use `GET /v1/requests/:id` for the current state and authorized request details.

The TypeScript client exposes `getRequestEvents(id, { limit, cursor })` with `RequestEvent`, `RequestEventsQuery`, and `RequestEventsPage` types.

## Read, cancel, claim, and report

| Route | Body | Success | Common errors |
| --- | --- | --- | --- |
| `GET /v1/requests/:id` | none | 200 request | 404 |
| `GET /v1/requests/:id/events` | none | 200 timeline page | 400, 404 |
| `POST /v1/requests/:id/cancel` | `{}` | 200 request; only while pending | 409, 404 |
| `POST /v1/requests/:id/claim` | `{}` | 200 claim object; only approved and unclaimed | 409, 404 |
| `POST /v1/requests/:id/result` | see below | 200 request; only from claimant, once | 403, 409, 404 |

Use the `id` returned by creation. These requests all require the same client's bearer key. The examples below use `REQUEST_ID` as a shell variable:

```sh
REQUEST_ID='paste-id-from-create-response'
curl -sS "http://127.0.0.1:3080/v1/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
```

`GET` returns the complete request object with HTTP 200. It can report a pending decision alongside `deliveryStatus` such as `retrying` or `failed`. A missing or other-client ID returns 404.

To cancel a **still-pending** request, send:

```sh
curl -sS -X POST "http://127.0.0.1:3080/v1/requests/$REQUEST_ID/cancel" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

Success returns HTTP 200 with `status: "cancelled"`. A settled or expired request returns 409 `invalid_state`.

After Telegram approval, claim once:

```sh
curl -sS -X POST "http://127.0.0.1:3080/v1/requests/$REQUEST_ID/claim" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' -d '{}'
```

Only `approved + unclaimed` can be claimed. Success returns HTTP 200 with the claim ID, one-time claim token, and updated request. A second claim returns 409 `not_claimable`.

Claim response:

```json
{
  "claimId": "9a5ca158-3ab6-4abe-92b6-f18c10c47463",
  "claimToken": "base64url-secret-returned-once",
  "request": { "id": "123e4567-e89b-42d3-a456-426614174000", "status": "approved", "executionStatus": "claimed" }
}
```

The `request` property is the complete request object shown above. Store the claim token privately until reporting the result; the gateway stores only its hash and cannot retrieve it later. The claim ID is an audit identifier, not authorization.

Reads, cancellation, claims, and results require the owning client's key. Another valid client key receives the same 404 `not_found` response as for an unknown request ID, including when it has a valid claim token. Claiming still requires `approved + unclaimed`; reporting still requires the one-time claim token. A Telegram approver can decide a client's request only when allowlisted for that client and tapping its recorded message in that client's configured chat.

Result body:

```json
{
  "claimToken": "the-token-from-claim",
  "status": "succeeded",
  "summary": "Deployment completed"
}
```

`status` is `succeeded` or `failed`. `summary` is 1–300 characters, one line, and should contain no secrets. A second report fails with 409.

```sh
CLAIM_TOKEN='paste-token-from-claim-response'
# Perform the exact approved action in your own app first, then report it:
curl -sS -X POST "http://127.0.0.1:3080/v1/requests/$REQUEST_ID/result" \
  -H "Authorization: Bearer $JAGATE_CLIENT_KEY" \
  -H 'Content-Type: application/json' \
  -d "{\"claimToken\":\"$CLAIM_TOKEN\",\"status\":\"succeeded\",\"summary\":\"Action completed\"}"
```

Success returns HTTP 200 with `executionStatus: "succeeded"` or `"failed"`. The gateway records the caller's report; it cannot verify the external action. Keep the claim token private until reporting succeeds.

## Health and errors

`GET /health` returns 200 `{"status":"ok"}` while the process can respond. `GET /ready` returns 200 if storage and Telegram polling/delivery are ready enough for new requests, otherwise 503, with `{"ready":false,"storage":true,"telegram":false}` style fields. New request creation returns 503 when not ready. Existing requests can still be read and reconciled.

Errors have a stable envelope:

```json
{ "error": { "code": "invalid_state", "message": "only a pending request can be cancelled" } }
```

Validation errors also include `issues: [{"path":"expiresInSeconds","message":"..."}]`. Codes: `invalid_input` (400), `unauthorized` (401), `insufficient_scope` / `invalid_claim_token` (403), `not_found` (404, including requests owned by another client), `idempotency_conflict` / `invalid_state` / `not_claimable` (409), `not_ready` (503), and `internal_error` (500). HTTP request bodies are limited to 12 KB. No error returns a client key, bot token, or claim token.

Delivery values: `pending`, `retrying`, `delivered`, `failed`. `deliveryError` is a sanitized transport error message and never contains caller content or credentials. A final `failed` delivery remains visible; submit a new request with a new idempotency key after fixing Telegram configuration. Retrying a failed request with the same key returns the same failed request, and no second notification is sent.

Decision values are `pending`, `approved`, `rejected`, `expired`, and `cancelled`. Execution values are `unclaimed`, `claimed`, `succeeded`, and `failed`. A claimed request with `resultAt: null` has an unknown external outcome after a crash; it is not made claimable again automatically. See [Security and recovery](/guide/security).
