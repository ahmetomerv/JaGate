# Local playground

The playground is a development-only Vue interface for exercising JaGate's HTTP API and approval lifecycle. It runs on your computer at `http://127.0.0.1:5173`. Its small backend listens on `127.0.0.1:3081`, keeps client keys server-side, and sends API responses to the interface. Neither server is part of the production gateway build or Docker image.

## Start it

Use Node.js 24.21.0. From the repository root:

```sh
nvm use
npm ci
npm run playground
```

Open `http://127.0.0.1:5173`. The default **Simulated Telegram** mode needs no `.env`, bot, network connection, or running gateway. It uses `data/playground.sqlite`, separate from the normal `data/gateway.sqlite` database. The two built-in test clients are `website` and `backups`, each with a separate simulated chat and approver. Stop the playground with Ctrl+C. Its request history and simulated clock offset remain in its database across restarts.

Choose an endpoint from the request list, edit its parameters or body, and click **Send**. The response pane shows the HTTP status and JSON body; its **History** tab keeps the last 20 responses in browser memory. The **JSON preview** tab shows the request body or list query before sending. Claim tokens appear in responses and in the claim-token field, but are not saved to browser storage; keep the playground private while testing. Recent requests are loaded from the authenticated list API for the selected client.

## Try each feature in simulated mode

1. **Create and decide:** Select **Create request** and send the default form. Select it from Recent requests and use **Approve** or **Reject**. Use the **Outsider** actor to see a rejected callback that leaves the request pending.
2. **Idempotency:** Send the create request again without changing the form. The response is HTTP 200 with the original ID. Change the title while keeping the same key and submit again for HTTP 409. Use **Generate new key** to start a separate request.
3. **Cancellation:** Create a new request, select **Cancel request** and send it, then try **Approve**. The decision stays `cancelled`.
4. **Expiry:** Set the expiry to 60 seconds, create a request, and advance the simulated clock by 61 seconds. Send **Get request** to see `expired`; a late approval cannot change it. The clock moves forward for all simulated requests and is saved across restarts.
5. **Claim and result:** Approve a fresh request, send **Claim approval**, then send **Report result** as `succeeded` or `failed`. A second claim returns HTTP 409. Change the claim token to see HTTP 403, or report twice to see HTTP 409.
6. **Authentication and client isolation:** Choose **Missing key** or **Invalid key** and fetch a request to see HTTP 401. `/health` and `/ready` remain available with either choice because they are public endpoints. Restore **Valid key**, select a `website` request, switch to `backups`, and click **Get request** to see HTTP 404. The two clients can use the same idempotency key independently.
7. **Persistence:** Stop and restart `npm run playground`. The simulated requests remain in Recent requests because they are stored in `data/playground.sqlite`.
8. **List and filter:** Select **List requests**, filter by decision, delivery, or execution status, and click **Send**. Open a listed request by selecting its row. Set a small page size and use **Next** and **Previous** to move through matches. Switch clients to see each client's own requests.

The simulated Approve and Reject controls call JaGate's real callback authorization and decision code using a fake Telegram transport. They are available **only** in simulated mode. The playground records reported outcomes; it never runs a caller's proposed action.

## Test the real gateway and Telegram

Configure JaGate as described in [Get started locally](/guide/getting-started). Build it, then start it in a separate terminal:

```sh
npm run build
npm run start:local
```

Start `npm run playground` in another terminal and select **Real gateway**. The playground loads valid client IDs and their keys from the repository's `.env` into its local backend. The interface receives the IDs but never receives the client keys. By default it calls `http://127.0.0.1:3080`; set `GATEWAY_URL` before starting the playground if your gateway uses another address.

Create a request in the playground, then approve or reject it in the configured Telegram chat. Use **Get request** to refresh its status. Cancellation, idempotency, authentication, client isolation, claims, results, and listing use the running gateway's normal HTTP routes. Recent live requests reload from the gateway when you refresh the page or change clients. The playground does not read or modify the gateway's SQLite file directly.

Real mode does not provide an **Advance clock** control or browser approval buttons. Waiting for a real expiry requires the configured duration. To test restart persistence, restart JaGate without deleting its database, then fetch a saved request. To test the Docker build, stop the local gateway process, start [Docker Compose](/guide/docker), and use Real gateway mode against its loopback port. Only one process should poll a given Telegram bot token.

## Scope and safety

The playground is for local development. Both listeners bind to `127.0.0.1`; do not expose or reverse-proxy them. A random browser session token is required for playground operations. Client keys stay in the local backend, while one-time claim tokens appear in the response panel so you can complete result reporting. Avoid using production keys or real side effects in a test session. The list route follows the gateway's normal client authorization rules.
