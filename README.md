# JaGate

A small self-hosted gateway for actions that need a human decision. An application submits a description, an allowlisted person decides in Telegram, and the application reads the decision. The gateway never runs the proposed action. The application keeps its own credentials and performs the action only after it claims an approval.

This first release runs one Node.js 24.21.0 LTS process with SQLite, one Telegram bot, one destination chat, one or more named API clients, and one or more numeric approver user IDs. Any language can use the HTTP API. A TypeScript client is included.

## Quick start with Docker Compose

1. Create a **dedicated** bot with Telegram's BotFather. Send it a message, or add it to the intended group and send a message there. Before starting this gateway, inspect `getUpdates` using the bot token. Use `message.chat.id` for `TELEGRAM_CHAT_ID` and each trusted `message.from.id` for `TELEGRAM_APPROVER_IDS`. These are numeric IDs; group chat IDs are often negative. Telegram's response may contain private messages, so keep it private.

   ```sh
   export TELEGRAM_BOT_TOKEN='paste-your-dedicated-bot-token'
   curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
   ```

2. Copy the configuration template, generate a client key, and edit `.env`. Replace the placeholder after `example:` in `CLIENT_KEYS` with the generated key. Add the bot token, chat ID, and comma-separated approver IDs. The sample values are placeholders.

   ```sh
   cp .env.example .env
   openssl rand -hex 32
   # Edit .env and paste the generated key after example: in CLIENT_KEYS.
   docker compose up --build -d
   curl -sS http://127.0.0.1:3080/ready
   ```

   `/ready` returns HTTP 200 with `{"ready":true,"storage":true,"telegram":true}` when it can accept requests. A bot with an existing webhook or another long poller fails startup with an actionable message; the gateway never deletes a webhook. `docker compose logs gateway` shows startup and transport errors without secrets.

3. Submit a request. The next command extracts the `example` key from the single-client `.env.example` format. For multiple clients, set `JAGATE_CLIENT_KEY` to the key for the client making the call. Approve or reject the Telegram message, then fetch the returned request ID.

   ```sh
   set -a; . ./.env; set +a
   export JAGATE_CLIENT_KEY="${CLIENT_KEYS#example:}"
   curl -sS -X POST http://127.0.0.1:3080/v1/requests \
     -H "Authorization: Bearer $JAGATE_CLIENT_KEY" -H 'Content-Type: application/json' \
     -d '{"idempotencyKey":"readme-demo-1","action":"local-demo","title":"Approve a local demo","description":"Allow a harmless local demo step","details":[{"label":"Environment","value":"local"}],"expiresInSeconds":900}'
   # Copy the id from the response:
   curl -sS http://127.0.0.1:3080/v1/requests/REQUEST_ID \
     -H "Authorization: Bearer $JAGATE_CLIENT_KEY"
   ```

   After approval, claim and report the result. Use the actual request ID and copy the one-time `claimToken` from the claim response:

   ```sh
   REQUEST_ID='paste-id-from-create-response'
   curl -sS -X POST "http://127.0.0.1:3080/v1/requests/$REQUEST_ID/claim" \
     -H "Authorization: Bearer $JAGATE_CLIENT_KEY" -H 'Content-Type: application/json' -d '{}'
   CLAIM_TOKEN='paste-token-from-claim-response'
   # Perform the exact approved action in your own application, then:
   curl -sS -X POST "http://127.0.0.1:3080/v1/requests/$REQUEST_ID/result" \
     -H "Authorization: Bearer $JAGATE_CLIENT_KEY" -H 'Content-Type: application/json' \
     -d "{\"claimToken\":\"$CLAIM_TOKEN\",\"status\":\"succeeded\",\"summary\":\"Local action completed\"}"
   ```

   To cancel a different request while it is still pending, POST `{}` to `/v1/requests/REQUEST_ID/cancel` with the same authorization header.

The first POST returns HTTP 201. Repeating the same body and idempotency key under the same client returns the existing request with HTTP 200. A changed body with that client and key returns HTTP 409. Different clients can use the same idempotency key independently. The JSON `deliveryStatus` changes from `pending` to `delivered`, `retrying`, or `failed`. To run a full harmless local action after approval, use the exported `JAGATE_CLIENT_KEY` above and then `node --import tsx examples/demo.ts` after `npm ci` on Node 24.21.0. The demo writes a uniquely named text file in the OS temporary directory; it uses your configured gateway and real Telegram approval.

To run the same lifecycle entirely locally with an in-memory database and fake Telegram transport, run `npm run demo:fake`. It creates, delivers, approves, claims, and reports one harmless console message without a token or network call.

## TypeScript caller

Use Node 24.21.0 (`nvm use` when using nvm). Build this checkout with `npm ci && npm run build`, then install it from its absolute local path in a Node application (`npm install /absolute/path/to/this/checkout`). The client export has no server startup side effects.

```ts
import { ApprovalClient, WaitTimeoutError } from 'jagate';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const client = new ApprovalClient({
  baseUrl: 'http://127.0.0.1:3080',
  apiKey: process.env.JAGATE_CLIENT_KEY!,
});

const revision = 'abc123';
const request = await client.createRequest({
  idempotencyKey: `example-file:${revision}`,
  action: 'write-local-file',
  title: 'Write a local example file',
  description: `Write a text file for revision ${revision} in the temporary directory`,
  details: [
    { label: 'Directory', value: tmpdir() },
    { label: 'Revision', value: revision },
  ],
  expiresInSeconds: 900,
  metadata: {},
});

try {
  const decision = await client.waitForDecision(request.id, { timeoutMs: 900_000 });
  if (decision.status === 'approved') {
    const claim = await client.claim(request.id);
    const file = join(tmpdir(), `approval-example-${request.id}.txt`);
    try {
      await writeFile(file, `Approved revision ${revision}\n`, { flag: 'wx' });
    } catch (error) {
      await client.reportResult(request.id, { claimToken: claim.claimToken, status: 'failed', summary: 'Local file could not be written' });
      throw error;
    }
    await client.reportResult(request.id, { claimToken: claim.claimToken, status: 'succeeded', summary: 'Local file written' });
    console.log(file);
  } else {
    console.log(`No file written: ${decision.status}`);
  }
} catch (error) {
  if (error instanceof WaitTimeoutError) console.log('The client stopped waiting; check the request later.');
  else throw error;
}

```

`waitForDecision` polls at a bounded interval and accepts an `AbortSignal`. `WaitTimeoutError` is only a client-side wait limit; a server-side expiry is returned as `status: "expired"`.

## Trust model and state

The caller chooses and stores the action and parameters. The gateway validates and stores the submitted content immutably, shows the client ID, title, description, details, action type, short ID, and expiry to the approver, and records a decision. The caller must execute the same parameters it submitted and approved; the gateway cannot inspect a separate external action. `metadata` is for the owning client and is never put in Telegram. Do not submit secrets as display text. Each client key protects only that client's `/v1` requests; Telegram callbacks additionally require the configured numeric user ID, chat ID, and the stored message identity. A Telegram username or a forwarded button is not authority.

Decision: `pending → approved | rejected | expired | cancelled`. Only a pending request can be decided or cancelled. Pending requests expire at their deadline, including across restarts. Execution: `unclaimed → claimed → succeeded | failed`, and only an approved request can be claimed. The claim is a conditional SQLite update, so one request produces one successful claim. `claimed` with `resultAt: null` means the outcome is **unknown**, not that the action failed. It is never automatically reset after a crash: the caller may have completed the side effect before crashing. The claimant should retain the returned claim token until it reports a result. If the token or process is lost, an operator must inspect the target system and reconcile there before creating any new request. Use a separate idempotency key at the target system when available. The gateway cannot guarantee exactly once execution of an external side effect.

Telegram delivery is durable and retried for transient failures with backoff (up to five attempts). If the process crashes after Telegram accepts a message but before SQLite records its message ID, a duplicate message can appear after restart; only the message ID recorded in SQLite can decide the request. Polling progress is stored after an update is handled. Buttons on expired or settled requests get a status response. Editing the Telegram message after a decision is best effort; SQLite remains authoritative.

## Deployment and security

The server binds to `127.0.0.1` outside Docker. Compose publishes only on host loopback. To serve other machines, put an authenticated TLS reverse proxy or private network in front of it; do not expose the bare API publicly. Keep client keys, bot token, and claim tokens out of logs and source control. Use a dedicated bot. Give access to the destination chat only to the intended people, and explicitly allowlist their numeric user IDs. All clients still share that one destination chat and approver list; per-client keys isolate HTTP request access, not human approvers or Telegram visibility. The gateway does not execute caller-provided commands, URLs, scripts, or callbacks, and it does not need action credentials.

`CLIENT_KEYS` uses `clientId:key` entries separated by commas, for example `website:<random-key>,backups:<different-random-key>`. Client IDs are lowercase letters, digits, `_`, or `-`, start with a letter, and are at most 32 characters. Keys are unique, 32–128 URL-safe characters; generate each with `openssl rand -hex 32`. Client IDs are shown to approvers. Give each application only its own key. Changing a client's key while keeping its ID preserves its request access; removing the client ID makes its existing requests inaccessible through HTTP until it is configured again. The old single `API_KEY` setting is no longer accepted on its own.

Compose stores SQLite in the `jagate-data` volume. Back up that volume regularly. This uses SQLite's online backup API while the service is running:

```sh
docker compose exec -T gateway node -e 'const db=require("better-sqlite3")("/app/data/gateway.sqlite"); db.backup("/app/data/gateway-backup.sqlite").then(()=>db.close())'
docker compose cp gateway:/app/data/gateway-backup.sqlite ./gateway-backup.sqlite
docker compose exec -T gateway rm /app/data/gateway-backup.sqlite
```

Keep backups private because request text and metadata are stored in SQLite. Test a restore into a separate volume before relying on it. Do not copy only the main database file while WAL writes are active. One gateway process owns the bot token and this database; multiple processes or pollers are unsupported.

The initial database schema is in `migrations/001_initial.sql` and includes client ownership. The migration runner records the version on first startup and is ready for future schema changes. Back up the SQLite database before applying a future upgrade.

## When to use this

Use it when one or several services need a narrow human approval checkpoint and each can own its own execution logic. A workflow platform is a better fit for many steps, integrations, or a visual editor. A Telegram bot framework is a better fit when you want to build a broader bot conversation. This project is a focused approval coordinator with one channel.

See the [architecture and schema overview](docs/ARCHITECTURE.md), [API reference](docs/API.md), [contribution guide](CONTRIBUTING.md), and [changelog](CHANGELOG.md).
