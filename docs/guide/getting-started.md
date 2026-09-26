# Get started locally

This walkthrough runs JaGate on your computer and asks for approval before writing one harmless text file in your operating system's temporary directory. Use a **dedicated** Telegram bot. The gateway calls Telegram over long polling; you do not need a public webhook URL.

## 1. Check Node.js and build

JaGate requires Node.js 24.21.0 for this release. From the repository root:

```sh
nvm use                 # if you use nvm
node -v                 # v24.21.0
npm ci
npm run build
npm run demo:fake
```

The fake demo runs the whole create → approve → claim → result lifecycle without a bot token or network request. It is a useful first check before configuring Telegram.

For an interactive way to test idempotency, cancellation, expiry, claims, and client isolation, run `npm run playground` and open `http://127.0.0.1:5173`. See the [Local playground](/guide/playground) guide. Its simulated mode needs no bot or `.env`; Real gateway mode connects to the service started below.

## 2. Create a bot and find numeric IDs

Create a bot with [BotFather](https://t.me/BotFather). Send the bot a message in a private chat, or add it to a group and send a message there. Before JaGate starts polling, inspect updates using the bot token:

```sh
export TELEGRAM_BOT_TOKEN='paste-your-dedicated-bot-token'
curl -sS "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates"
```

Use `message.chat.id` as the route's `chatId`, and each trusted human `message.from.id` as an entry in `approverIds`. A group ID is usually negative. The bot's own `id`, usernames, `update_id`, and `message_id` are **not** approver IDs. A `my_chat_member` update can also show the group's `chat.id`, but send a normal message to confirm the human `from.id`. Keep the bot token and the update response private.

If `chat.type` is `group`, JaGate will send approvals to that group. A Telegram channel is a different chat type; the tested local flow uses a private chat or group.

## 3. Configure JaGate

```sh
cp .env.example .env
openssl rand -hex 32
```

Edit `.env` with the generated client key, the BotFather token, and your numeric IDs:

```dotenv
CLIENT_KEYS=example:paste-generated-64-character-hex-key
TELEGRAM_BOT_TOKEN=paste-your-dedicated-bot-token
TELEGRAM_ROUTES='{"example":{"chatId":"-1001234567890","approverIds":["123456789"]}}'
DATABASE_PATH=./data/gateway.sqlite
HOST=127.0.0.1
PORT=3080
```

The values above are examples, not real credentials. `.env` and `data/` are ignored by Git. `CLIENT_KEYS` assigns the client ID `example` its own bearer key; `TELEGRAM_ROUTES` sends its requests to that chat and allows only those numeric user IDs to decide. See [Configuration and clients](/guide/configuration) to add more applications and destinations.

## 4. Start the gateway

In terminal 1, from the repository root:

```sh
npm run start:local
```

You should see `JaGate listening on 127.0.0.1:3080`. In terminal 2, check readiness:

```sh
curl -i http://127.0.0.1:3080/ready
```

HTTP 200 with `{"ready":true,"storage":true,"telegram":true}` means it can accept new requests. `/health` checks only process liveness. If startup fails, read terminal 1: the bot may lack chat access, have an existing webhook, or already be used by another poller. JaGate does not remove another bot's webhook.

## 5. Test approval and rejection

In terminal 2, load the **single-client example** configuration and run the real demo:

```sh
set -a; . ./.env; set +a
export JAGATE_CLIENT_KEY="${CLIENT_KEYS#example:}"
node --import tsx examples/demo.ts
```

The demo prints a request ID and waits for a Telegram decision. Tap **Approve** in the configured chat. The example claims the approval, writes a uniquely named text file in the OS temporary directory, reports success, and prints its path. Run the demo again and tap **Reject**; no file is written. The demo needs no application credentials beyond its JaGate client key because its action is only a local file write.

When you are done, press Ctrl+C in terminal 1. The SQLite file remains in `data/`, so requests and decisions survive a restart. Do not start a second JaGate process with the same bot token.

Next: try the [HTTP API](/API) directly, use the [TypeScript client](/guide/typescript), or run with [Docker Compose](/guide/docker).
