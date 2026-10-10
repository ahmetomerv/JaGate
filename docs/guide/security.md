# Security and recovery

JaGate decides and coordinates approval. It **never executes** a caller-supplied command, URL, script, or callback. The calling application keeps action credentials and performs the exact approved action after claiming the request.

## Trust boundaries

- Every `/v1` request needs a configured bootstrap key or an active issued key. A client can access only its own requests; issued keys also need the route's scope and must be unexpired and unrevoked. Keep bootstrap keys for administration, issue limited keys with an expiry where practical, and revoke them when no longer needed. Do not put keys in source control, logs, or browser code. Only bootstrap keys can read the client-scoped audit feed; it records key IDs for successful create, claim, report, issuance, and revocation actions without storing credentials.
- Each client has a distinct configured Telegram destination. Only that client's allowlisted **numeric user IDs** in its chat can approve or reject. One bot serves all destination chats. Usernames and possession of a forwarded message do not authorize decisions. A user may be explicitly allowlisted for multiple clients.
- The Telegram message displays the client ID, title, description, details, action type, short request ID, and expiry. Caller metadata stays in SQLite and owner-scoped API responses; it is not displayed in Telegram. Avoid secrets in all request content and result summaries.
- JaGate binds a callback to the stored request, destination chat ID, and Telegram message ID, and conditionally settles pending, unexpired requests. Duplicate or late button taps cannot change a settled decision.
- The server binds to localhost by default. The Compose example publishes to host loopback. Use a private network or authenticated TLS reverse proxy if a remote client must reach it. Do not expose the bare HTTP port to the public internet.

## Decision, claim, and crash recovery

Decision states are `pending`, `approved`, `rejected`, `expired`, and `cancelled`. Execution states are `unclaimed`, `claimed`, `succeeded`, and `failed`. Only an approved, unclaimed request can be claimed. The claim response returns a token once; JaGate stores only its hash.

An approved request may be claimed after its approval deadline, because expiry applies only while pending. A pending request that reaches its deadline expires and fails closed. A claimed request with no result has an **unknown external outcome**. It remains claimed after restart: the caller might have completed the action before crashing. Never automatically retry the side effect just because JaGate shows `claimed`. Inspect the target system and reconcile it first. Use the target system's own idempotency key if available.

For a step-by-step reconciliation using request listing and the event timeline, see [Recover a claimed request after a crash](/guide/scenarios#recover-a-claimed-request-after-a-crash).

This gateway does not provide exactly once execution of external effects. It records what the claimant reports; it cannot verify or undo an external action.

## Telegram delivery and process restarts

Request creation is durable before Telegram delivery. Transient delivery errors retry with bounded backoff, and final failure is visible through `deliveryStatus` and `deliveryError`. A process crash after Telegram accepts a message but before SQLite saves its message ID may produce a duplicate message on retry; only the saved message can decide the request. Polling progress is persisted after processing an update. Message edits after a decision are best effort; SQLite remains authoritative.

On startup, JaGate checks access to every configured chat. If a client's chat ID changed, still-pending delivered requests are requeued with new buttons for the new chat. Old buttons become invalid. If only the approver list changes, the new list governs existing pending buttons after restart. Already-settled decisions are not reopened. See [Configuration and clients](/guide/configuration#changing-a-destination-or-approvers).

Keep the SQLite data volume and backups private. Use SQLite's online backup API while the gateway runs; see [Docker Compose backups](/guide/docker#back-up-sqlite). Test restores. Run only one JaGate instance with a given database and bot token.

## Operator console

The console is static files served by the gateway on the same origin as the API. Anyone who can open the port can load the HTML and JavaScript. Those files contain no keys. Every `/v1` call still requires a bearer key typed into the page. The key stays in memory for that tab and is dropped on sign-out, refresh, or a 401. Do not put a key in the console build, a Vite environment variable, browser storage, or the address bar.

Use an issued key with `requests:read` for daily viewing. Add `requests:cancel` only when that browser should cancel pending requests. Key issuance, revocation, and the audit feed require the bootstrap key. The console has no control that approves, rejects, claims, or reports a result. A claimed request with no reported result is shown as an unknown external outcome.

Metadata is visible in the console and was not sent to Telegram. Treat the console like the API: loopback by default, and a private network or authenticated TLS reverse proxy if a remote operator must reach it. Responses send a content security policy that keeps scripts on this origin, plus `nosniff`, `no-referrer`, and framing denial. Request text is rendered as text.
