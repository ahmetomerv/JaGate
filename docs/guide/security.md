# Security and recovery

JaGate decides and coordinates approval. It **never executes** a caller-supplied command, URL, script, or callback. The calling application keeps action credentials and performs the exact approved action after claiming the request.

## Trust boundaries

- Every `/v1` request needs a configured client bearer key. A client can access only its own requests. Give each application its own key; do not put keys in source control, logs, or browser code.
- All client requests go to one configured Telegram chat. Only allowlisted **numeric user IDs** in that chat can approve or reject. Usernames and possession of a forwarded message do not authorize decisions. All approvers can decide all clients' requests in this first release.
- The Telegram message displays the client ID, title, description, details, action type, short request ID, and expiry. Caller metadata stays in SQLite and owner-scoped API responses; it is not displayed in Telegram. Avoid secrets in all request content and result summaries.
- JaGate binds a callback to the stored request and Telegram message ID, and conditionally settles pending, unexpired requests. Duplicate or late button taps cannot change a settled decision.
- The server binds to localhost by default. The Compose example publishes to host loopback. Use a private network or authenticated TLS reverse proxy if a remote client must reach it. Do not expose the bare HTTP port to the public internet.

## Decision, claim, and crash recovery

Decision states are `pending`, `approved`, `rejected`, `expired`, and `cancelled`. Execution states are `unclaimed`, `claimed`, `succeeded`, and `failed`. Only an approved, unclaimed request can be claimed. The claim response returns a token once; JaGate stores only its hash.

An approved request may be claimed after its approval deadline, because expiry applies only while pending. A pending request that reaches its deadline expires and fails closed. A claimed request with no result has an **unknown external outcome**. It remains claimed after restart: the caller might have completed the action before crashing. Never automatically retry the side effect just because JaGate shows `claimed`. Inspect the target system and reconcile it first. Use the target system's own idempotency key if available.

This gateway does not provide exactly once execution of external effects. It records what the claimant reports; it cannot verify or undo an external action.

## Telegram delivery and process restarts

Request creation is durable before Telegram delivery. Transient delivery errors retry with bounded backoff, and final failure is visible through `deliveryStatus` and `deliveryError`. A process crash after Telegram accepts a message but before SQLite saves its message ID may produce a duplicate message on retry; only the saved message can decide the request. Polling progress is persisted after processing an update. Message edits after a decision are best effort; SQLite remains authoritative.

Keep the SQLite data volume and backups private. Use SQLite's online backup API while the gateway runs; see [Docker Compose backups](/guide/docker#back-up-sqlite). Test restores. Run only one JaGate instance with a given database and bot token.
