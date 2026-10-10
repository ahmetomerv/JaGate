# Local playground

The playground is a development-only Vue interface for exercising JaGate's HTTP API and approval lifecycle. It runs on your computer at `http://127.0.0.1:5173`. Its small backend listens on `127.0.0.1:3081`, keeps client keys server-side, and sends API responses to the interface. Neither server is part of the production gateway build or Docker image.

## Start it

Use Node.js 24.21.0. From the repository root:

```sh
nvm use
npm ci
npm run playground
```

Open `http://127.0.0.1:5173`. The default **Simulated Telegram** mode needs no `.env`, bot, network connection, or running gateway. It uses `data/playground.sqlite`, separate from the normal `data/gateway.sqlite` database. A **client** is an application or automation that calls JaGate, not a human approver. The header chooses the environment, the client, and **Calling as** (the bootstrap key, an issued key, a missing key, or an invalid key). Four sections follow the product rather than a list of routes:

| Section           | What you do there                                                                                          |
| ----------------- | ---------------------------------------------------------------------------------------------------------- |
| **This approval** | Ask for an approval, decide it in a simulated Telegram chat, claim it, and report what the application did |
| **All requests**  | Filter this client's requests, including failed delivery, old claims, and approvals that expire soon       |
| **Keys**          | Issue, list, and revoke scoped keys, then read the audit log                                               |
| **Gateway**       | Check public health and readiness                                                                          |

The three simulated clients are:

| Client ID         | Calling system        | Sample approval                     |
| ----------------- | --------------------- | ----------------------------------- |
| `ci-pipeline`     | CI/CD pipeline        | Deploy an API release to production |
| `cloud-ops`       | Cloud operations tool | Delete an old database snapshot     |
| `billing-service` | Billing service       | Issue a high-value customer refund  |

Each client has its own simulated key, requests, Telegram chat, and approver. **This approval** opens on that client's example. The fields stay editable. JaGate handles approval only: the simulator does not deploy, delete, or refund anything. Stop the playground with Ctrl+C. Request history and the simulated clock offset remain in its database across restarts. Requests created with older playground versions under `website` or `backups` remain in that database, but are not shown under the new example clients.

The left side of **This approval** lists this client's recent requests. **New approval** starts another one and fills a fresh idempotency key. **Ask for approval** submits the form. The same screen then shows the four parts of a real approval: what the application asked, the Telegram decision, the claim and report, and the recorded timeline. **API response** at the bottom shows the HTTP status and JSON. Its history keeps the last 20 responses in browser memory. Changing client or mode clears the displayed response while leaving that history available. Claim tokens and newly issued client keys appear in the response and, for the issued key, in the session field. They are not saved to browser storage. Keep the playground private while testing.

## Try each feature in simulated mode

1. **Create and decide:** Stay on **This approval** and click **Ask for approval**. In the Telegram step, leave **Who presses the button** on **Allowlisted approver** and click **Approve** or **Reject**. Choose **Someone else** and approve again: the reply says the person is not allowed, and the decision stays `pending`.
2. **Idempotency:** Click **New approval**, put back the same idempotency key and the same text, and ask again. JaGate returns the original request with HTTP 200. Change the title, keep the key, and ask again for HTTP 409. **New key** starts a separate request.
3. **Cancellation:** Ask with a new key. While the decision is pending, click **Cancel this request**, then **Approve**. The decision stays `cancelled`.
4. **Expiry:** Set **Open for (seconds)** to 60, ask with a new key, and **Move the clock forward** by 61 seconds. The decision becomes `expired`. A later **Approve** does not change it. The clock moves forward for every simulated request and is saved across restarts.
5. **Claim and result:** Approve a fresh request, click **Claim this approval**, then **Report succeeded** or **Report failed**. **Claim again** returns HTTP 409. Change the claim token and report to see HTTP 403. Reporting a second time also returns HTTP 409.
6. **Authentication and client isolation:** Choose **Missing key** or **Invalid key** under **Calling as** and open a request. The read returns HTTP 401. **Gateway** still checks health and readiness, because those endpoints are public. Restore **Bootstrap key**, open a `ci-pipeline` request, and switch the client to `cloud-ops` or `billing-service`. That client cannot see the request (HTTP 404). All three clients can use the same idempotency key independently.
7. **Persistence:** Stop and restart `npm run playground`. The simulated requests remain in the client list because they are stored in `data/playground.sqlite`.
8. **List and filter:** Open **All requests**. Set decision, delivery, application, or the UTC claim and expiry cutoffs, then click **Show these requests**. Open a row to return to its approval. Set a small page size and use **Next** and **Previous**. Switch clients to see each client's own requests.
9. **Requests needing attention:** On **All requests**, set a window in minutes and click **Failed delivery**, **Old claims**, or **Expiring soon**. Each shortcut fixes its UTC cutoff at click time, using the simulated clock in simulated mode; edit the cutoff and click **Show these requests** to try an exact boundary. For **Old claims**, approve and claim a request, move the clock beyond the window, then apply the shortcut. For **Expiring soon**, ask with a 60-second expiry and use a window longer than 1 minute. On **This approval**, click **Make the next message fail**, then **Ask for approval**, to record a failed Telegram delivery. **Failed delivery** then lists that pending request. In real mode the same shortcut lists requests whose Telegram delivery has failed. **Clear filters** restores the full listing. Paging keeps the same cutoff until you apply a shortcut again. These controls only query state; an old claim still requires reconciliation with the caller's target system.
10. **Request timeline:** Open an approval. **What JaGate recorded** lists creation, Telegram delivery, the decision, the claim, and the reported outcome in order. Set **Events per page** to 1 and leave the field to use **Next** and **Previous**. Switch clients or use **Missing key** to verify access control. Events are saved in SQLite, so restart the playground and open the same approval again. Older requests may have no recorded events until a new transition occurs.
11. **Scoped, expiring, and revocable keys:** Keep **Calling as** on **Bootstrap key**. Open **Keys**, turn off **Ask for approval** so only **Read requests** remains, and click **Issue key**. Copy the key while it is visible. The playground also keeps it in **Issued key** for this browser session. Click **Call as this key**, or choose **Issued key** in the header. **Show these requests** on **All requests** succeeds. **Ask for approval** returns HTTP 403 `insufficient_scope`. To try expiry, switch **Calling as** back to **Bootstrap key**, issue another key, click **Expire in 1 hour** (or enter a future UTC timestamp), call as that key, move the simulated clock past its expiry, and show requests again: the key returns HTTP 401. Switch back to **Bootstrap key**, click **Show keys**, and **Revoke** one. That issued key then returns HTTP 401. The configured bootstrap key is rotated in `.env`, not from this screen.
12. **Key audit:** With **Bootstrap key** selected, open **Keys** and click **Show audit**. Successful key issuance and revocation appear alongside request creation, claims, and reported results. Filter by a request id or a key id. Use a page size of 1 to exercise **Next** and **Previous**, and switch to `cloud-ops` to see its own audit feed. An issued key cannot read this list. Audit rows show key ids, not secret key values or claim tokens.

**Approve** and **Reject** call JaGate's real callback authorization and decision code through a fake Telegram transport. They are available only in simulated mode. The playground records reported outcomes. The calling application is what performs the action.

## Test the real gateway and Telegram

Configure JaGate as described in [Get started locally](/guide/getting-started). Build it, then start it in a separate terminal:

```sh
npm run build
npm run start:local
```

Start `npm run playground` in another terminal and select **Real gateway**. The playground loads valid client IDs and their keys from the repository's `.env` into its local backend. The interface receives the IDs but never receives the client keys. By default it calls `http://127.0.0.1:3080`; set `GATEWAY_URL` before starting the playground if your gateway uses another address.

Ask for a request in the playground, then approve or reject it in the configured Telegram chat. **Refresh** on the Telegram step loads the decision, and **What JaGate recorded** shows the timeline. The [operator console](/guide/console) can list and read those same live requests; it does not create, claim, or report them. Cancellation, idempotency, authentication, client isolation, claims, results, listing, timeline reads, issued-key management, expiry, and audit reads use the running gateway's normal HTTP routes. Recent live requests reload from the gateway when you refresh the page or change clients. The playground does not read or modify the gateway's SQLite file directly.

Real mode has no clock control and no browser approval buttons. Waiting for a real expiry requires the configured duration. To test restart persistence, restart JaGate without deleting its database, then open a saved request. To test the Docker build, stop the local gateway process, start [Docker Compose](/guide/docker), and use Real gateway mode against its loopback port. Only one process should poll a given Telegram bot token.

## Scope and safety

The playground is for local development. Both listeners bind to `127.0.0.1`; do not expose or reverse-proxy them. A random browser session token is required for playground operations. Configured bootstrap keys stay in the local backend. Newly issued keys and one-time claim tokens appear in the response panel; the issued-key field holds a pasted or newly created key only in browser memory and sends it to the local backend for the selected API call. Avoid using production keys or real side effects in a test session. Client authorization follows the gateway's normal rules.
