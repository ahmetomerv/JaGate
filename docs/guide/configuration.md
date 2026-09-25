# Configuration and clients

JaGate reads configuration from environment variables. The local walkthrough uses Node's `--env-file=.env`; Docker Compose reads the same file through `env_file`. There is no unauthenticated API mode.

| Variable | Required | Meaning |
| --- | --- | --- |
| `CLIENT_KEYS` | Yes | Comma-separated `clientId:key` entries. Each application gets its own key. |
| `TELEGRAM_BOT_TOKEN` | Yes | Token for a dedicated bot from BotFather. |
| `TELEGRAM_CHAT_ID` | Yes | Numeric private or group chat ID to receive approval messages. |
| `TELEGRAM_APPROVER_IDS` | Yes | Comma-separated numeric Telegram user IDs allowed to decide. |
| `DATABASE_PATH` | No | SQLite path; defaults to `./data/gateway.sqlite`. |
| `HOST` | No | HTTP bind address; defaults to `127.0.0.1`. |
| `PORT` | No | HTTP port; defaults to `3080`. |

Generate a separate key for each application with `openssl rand -hex 32`. Client IDs must start with a lowercase letter, use only lowercase letters, digits, `_`, or `-`, and be no more than 32 characters. Keys must be unique, 32–128 URL-safe characters. Up to 32 clients can be configured. Do not include spaces in the comma-separated value.

```dotenv
CLIENT_KEYS=website:<first-random-key>,backups:<second-random-key>
```

Give the website app only its `website` key and the backup app only its `backups` key. The HTTP API derives `clientId` from the key; a caller cannot set ownership in the request body. Each client can create and read only its own requests. A client attempting to read, cancel, claim, or report another client's request receives `404 not_found`, even with a valid claim token. Idempotency keys are unique **within one client**, so both apps may use `daily:2026-09-25` independently.

The client ID is displayed in Telegram so an approver knows which application requested a decision. All configured clients share the same destination chat and the same Telegram approver allowlist. A Telegram approver can decide requests from every client. This is client API isolation, not separate approval teams.

You can rotate a key by changing its value while keeping the client ID; requests stay owned by that ID. Restart JaGate to load the new environment. Removing a client ID prevents HTTP access to its existing requests until that ID is configured again. Store client keys, the bot token, and claim tokens outside source control and logs.

## Two-client example

Generate two different keys, put them in `.env` as `CLIENT_KEYS=website:<website-key>,backups:<backups-key>`, and start JaGate. Each application receives only its own key. In a separate terminal, set the keys for this example without committing them to source control:

```sh
export WEBSITE_KEY='paste-website-key-from-your-env'
export BACKUPS_KEY='paste-backups-key-from-your-env'
```

The website client can create an approval:

```sh
curl -sS -X POST http://127.0.0.1:3080/v1/requests \
  -H "Authorization: Bearer $WEBSITE_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"idempotencyKey":"publish:example-1","action":"publish","title":"Publish example page","description":"Publish the example page from the website application","expiresInSeconds":900}'
```

Copy its returned `id` and check ownership with both keys:

```sh
REQUEST_ID='paste-id-from-create-response'
curl -i "http://127.0.0.1:3080/v1/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $WEBSITE_KEY"  # 200
curl -i "http://127.0.0.1:3080/v1/requests/$REQUEST_ID" \
  -H "Authorization: Bearer $BACKUPS_KEY"  # 404 not_found
```

The backups client can create its own request, even with the same `idempotencyKey`. It cannot claim or report the website request. Both approvals still appear in the one configured Telegram chat, labeled by client ID.

For a different machine to call JaGate, use a private network or an authenticated TLS reverse proxy. Local Node startup binds to loopback, and the supplied Compose file publishes the port only on host loopback. See [Security and recovery](/guide/security).
