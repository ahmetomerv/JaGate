# Local playground

The playground is a development-only Vue interface for exercising JaGate's HTTP API and approval lifecycle. It runs on your computer at `http://127.0.0.1:5173`. Its small backend listens on `127.0.0.1:3081`, keeps client keys server-side, and sends API responses to the interface. Neither server is part of the production gateway build or Docker image.

## Start it

Use Node.js 24.21.0. From the repository root:

```sh
nvm use
npm ci
npm run playground
```

Open `http://127.0.0.1:5173`. The default **Simulated Telegram** mode needs no `.env`, bot, network connection, or running gateway. It uses `data/playground.sqlite`, separate from the normal `data/gateway.sqlite` database. A **client** is an application or automation that calls JaGate, not a human approver. The three simulated clients are:

| Client ID | Calling system | Sample approval |
| --- | --- | --- |
| `ci-pipeline` | CI/CD pipeline | Deploy an API release to production |
| `cloud-ops` | Cloud operations tool | Delete an old database snapshot |
| `billing-service` | Billing service | Issue a high-value customer refund |

Each client has its own simulated key, requests, Telegram chat, and approver. Selecting a client loads its example request into the editor; the fields remain editable. JaGate handles approval only: the simulator does not deploy, delete, or refund anything. Stop the playground with Ctrl+C. Request history and the simulated clock offset remain in its database across restarts. Requests created with older playground versions under `website` or `backups` remain in that database, but are not shown under the new example clients.

Choose an endpoint from the sidebar, edit its parameters or body, and click **Send**. The response pane shows the HTTP status and JSON body; its **History** tab keeps the last 20 responses in browser memory. Selecting another endpoint, client, or mode clears the displayed response while leaving History available. The **JSON preview** tab shows the request body or query before sending. Claim tokens and newly issued client keys appear in responses but are not saved to browser storage; keep the playground private while testing. Recent requests are loaded from the authenticated list API for the selected client.

## Try each feature in simulated mode

1. **Create and decide:** Select **Create request** and send the selected client's example form. Select it from Recent requests and use **Approve** or **Reject**. Use the **Outsider** actor to see a rejected callback that leaves the request pending.
2. **Idempotency:** Send the create request again without changing the form. The response is HTTP 200 with the original ID. Change the title while keeping the same key and submit again for HTTP 409. Use **Generate new key** to start a separate request.
3. **Cancellation:** Create a new request, select **Cancel request** and send it, then try **Approve**. The decision stays `cancelled`.
4. **Expiry:** Set the expiry to 60 seconds, create a request, and advance the simulated clock by 61 seconds. Send **Get request** to see `expired`; a late approval cannot change it. The clock moves forward for all simulated requests and is saved across restarts.
5. **Claim and result:** Approve a fresh request, send **Claim approval**, then send **Report result** as `succeeded` or `failed`. A second claim returns HTTP 409. Change the claim token to see HTTP 403, or report twice to see HTTP 409.
6. **Authentication and client isolation:** Choose **Missing key** or **Invalid key** and fetch a request to see HTTP 401. `/health` and `/ready` remain available with either choice because they are public endpoints. Restore **Bootstrap key**, select a `ci-pipeline` request, switch to `cloud-ops` or `billing-service`, and click **Get request** to see HTTP 404. All three clients can use the same idempotency key independently.
7. **Persistence:** Stop and restart `npm run playground`. The simulated requests remain in Recent requests because they are stored in `data/playground.sqlite`.
8. **List and filter:** Select **List requests**, filter by decision, delivery, execution, or the UTC claim/expiry cutoffs, and click **Send**. Open a listed request by selecting its row. Set a small page size and use **Next** and **Previous** to move through matches. Switch clients to see each client's own requests.
9. **Requests needing attention:** In **List requests**, set a window in minutes and use **Failed delivery**, **Old claims**, or **Expiring soon** to fill the filters, then click **Send**. Each shortcut fixes its UTC cutoff at click time, using the simulated clock in simulated mode; edit the cutoff field to try an exact boundary. For **Old claims**, approve and claim a request, advance the clock beyond the window, then apply the shortcut. For **Expiring soon**, create a request with a 60-second expiry and use a window longer than 1 minute. The simulator normally delivers successfully, so **Failed delivery** may return no rows; that shortcut is useful in real mode if Telegram delivery has failed. **Clear filters** restores the full listing. Paging keeps the same cutoff until you reapply a shortcut. These controls only query state; an old claim still requires reconciliation with the caller's target system.
10. **Request timeline:** Select a recent request, then choose **Request timeline** and click **Send**. The events show creation, Telegram delivery, decisions, claims, and reported outcomes in order. Set a page size of 1 to exercise **Next** and **Previous**. Switch clients or use **Missing key** to verify access control. Events are saved in SQLite, so restart the playground and load the same timeline again. Older requests may have no recorded events until a new transition occurs.
11. **Scoped, expiring, and revocable keys:** Keep **Bootstrap key** selected, choose **Create client key**, deselect the default `requests:create` scope so only `requests:read` remains, and send. Copy the returned `key` while it is visible; the playground also fills the **Issued key** field for this browser session. Choose **Issued key** under Auth. **List requests** succeeds, while **Create request** returns HTTP 403 `insufficient_scope`. To try expiry, switch back to **Bootstrap key**, create another key with **Set 1 hour from now** (or enter a future UTC timestamp), select **Issued key**, advance the simulated clock past its expiry, and send **List requests**: the key now returns HTTP 401. Switch back to **Bootstrap key**, choose **List client keys** to see metadata without secrets, select a key, and send **Revoke client key**. That issued key also returns HTTP 401. The configured bootstrap key is rotated in `.env`, not through this endpoint.
12. **Key audit:** With **Bootstrap key** selected, choose **Audit events** and send. Successful key issuance and revocation appear alongside request creation, claims, and reported results. Filter by a request ID or an issued key ID. Use a page size of 1 to exercise cursor paging, and switch to `cloud-ops` to see its own audit feed. An issued key cannot read this endpoint. Audit rows show key IDs, not secret key values or claim tokens.

The simulated Approve and Reject controls call JaGate's real callback authorization and decision code using a fake Telegram transport. They are available **only** in simulated mode. The playground records reported outcomes; it never runs a caller's proposed action.

## Test the real gateway and Telegram

Configure JaGate as described in [Get started locally](/guide/getting-started). Build it, then start it in a separate terminal:

```sh
npm run build
npm run start:local
```

Start `npm run playground` in another terminal and select **Real gateway**. The playground loads valid client IDs and their keys from the repository's `.env` into its local backend. The interface receives the IDs but never receives the client keys. By default it calls `http://127.0.0.1:3080`; set `GATEWAY_URL` before starting the playground if your gateway uses another address.

Create a request in the playground, then approve or reject it in the configured Telegram chat. Use **Get request** to refresh its status or **Request timeline** to inspect its recorded transitions. Cancellation, idempotency, authentication, client isolation, claims, results, listing, timeline reads, issued-key management, expiry, and audit reads use the running gateway's normal HTTP routes. Recent live requests reload from the gateway when you refresh the page or change clients. The playground does not read or modify the gateway's SQLite file directly.

Real mode does not provide an **Advance clock** control or browser approval buttons. Waiting for a real expiry requires the configured duration. To test restart persistence, restart JaGate without deleting its database, then fetch a saved request. To test the Docker build, stop the local gateway process, start [Docker Compose](/guide/docker), and use Real gateway mode against its loopback port. Only one process should poll a given Telegram bot token.

## Scope and safety

The playground is for local development. Both listeners bind to `127.0.0.1`; do not expose or reverse-proxy them. A random browser session token is required for playground operations. Configured bootstrap keys stay in the local backend. Newly issued keys and one-time claim tokens appear in the response panel; the issued-key field holds a pasted or newly created key only in browser memory and sends it to the local backend for the selected API call. Avoid using production keys or real side effects in a test session. Client authorization follows the gateway's normal rules.
