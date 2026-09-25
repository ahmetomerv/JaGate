# HTTP API v1

Base URL: `http://127.0.0.1:3080` by default. All `/v1` routes require `Authorization: Bearer <CLIENT_KEY>`, using the key assigned to one configured client ID. Send JSON with `Content-Type: application/json` for POST. Dates are UTC ISO 8601 strings. `/health` and `/ready` are unauthenticated and contain no secrets. A client ID is derived from the bearer key; callers cannot choose or change it in the request body.

## Create a request

`POST /v1/requests` returns 201 for a new request and 200 for an exact idempotent repeat by the same client.

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

## Read, cancel, claim, and report

| Route | Body | Success | Common errors |
| --- | --- | --- | --- |
| `GET /v1/requests/:id` | none | 200 request | 404 |
| `POST /v1/requests/:id/cancel` | `{}` | 200 request; only while pending | 409, 404 |
| `POST /v1/requests/:id/claim` | `{}` | 200 claim object; only approved and unclaimed | 409, 404 |
| `POST /v1/requests/:id/result` | see below | 200 request; only from claimant, once | 403, 409, 404 |

Claim response:

```json
{
  "claimId": "9a5ca158-3ab6-4abe-92b6-f18c10c47463",
  "claimToken": "base64url-secret-returned-once",
  "request": { "id": "123e4567-e89b-42d3-a456-426614174000", "status": "approved", "executionStatus": "claimed" }
}
```

The `request` property is the complete request object shown above. Store the claim token privately until reporting the result; the gateway stores only its hash and cannot retrieve it later. The claim ID is an audit identifier, not authorization.

Reads, cancellation, claims, and results require the owning client's key. Another valid client key receives the same 404 `not_found` response as for an unknown request ID, including when it has a valid claim token. Claiming still requires `approved + unclaimed`; reporting still requires the one-time claim token. Telegram approvers in the configured chat can decide requests from every client.

Result body:

```json
{
  "claimToken": "the-token-from-claim",
  "status": "succeeded",
  "summary": "Deployment completed"
}
```

`status` is `succeeded` or `failed`. `summary` is 1–300 characters, one line, and should contain no secrets. A second report fails with 409.

## Health and errors

`GET /health` returns 200 `{"status":"ok"}` while the process can respond. `GET /ready` returns 200 if storage and Telegram polling/delivery are ready enough for new requests, otherwise 503, with `{"ready":false,"storage":true,"telegram":false}` style fields. New request creation returns 503 when not ready. Existing requests can still be read and reconciled.

Errors have a stable envelope:

```json
{ "error": { "code": "invalid_state", "message": "only a pending request can be cancelled" } }
```

Validation errors also include `issues: [{"path":"expiresInSeconds","message":"..."}]`. Codes: `invalid_input` (400), `unauthorized` (401), `invalid_claim_token` (403), `not_found` (404, including requests owned by another client), `idempotency_conflict` / `invalid_state` / `not_claimable` (409), `not_ready` (503), and `internal_error` (500). HTTP request bodies are limited to 12 KB. No error returns a client key, bot token, or claim token.

Delivery values: `pending`, `retrying`, `delivered`, `failed`. `deliveryError` is a sanitized transport error message and never contains caller content or credentials. A final `failed` delivery remains visible; submit a new request with a new idempotency key after fixing Telegram configuration. Retrying a failed request with the same key returns the same failed request, and no second notification is sent.
