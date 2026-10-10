# Operator console

The console is a browser UI for one client. It lists requests that need attention, opens a request and its timeline, and can cancel a pending request when the key allows it. With that client's bootstrap key it can also issue and revoke keys and read the audit feed.

Decisions stay in Telegram. The console does not approve, reject, claim, or report a result. Keep the [playground](/guide/playground) for those steps while you are developing a caller.

## Run it locally

Start the gateway first, as in [Get started locally](/guide/getting-started). In another terminal, from the repository root:

```sh
npm run console:dev
```

Open `http://127.0.0.1:5174`. The dev server binds to loopback and proxies `/v1`, `/health`, and `/ready` to `http://127.0.0.1:3080`.

To serve the console from the gateway itself:

```sh
npm run build
npm run console:build
npm run start:local
```

Open `http://127.0.0.1:3080`. `npm start` and `npm run start:local` serve that build when `dist/console/index.html` is present beside the compiled server. `npm run dev` runs from source and does not serve it. The [Docker image](/guide/docker) builds that directory and serves it on the same port as the API.

The console is a Vue 3 app in `console/`, using Element Plus. It calls the existing HTTP API through a wrapper that exposes list, read, cancel, issued keys, and audit. It does not call create, claim, or result.

## What to sign in with

Paste one key into the form. The key stays in memory for that tab. Sign-out, refresh, and a rejected key all drop it. It is not written to browser storage, the page URL, or the built JavaScript.

Use an issued key with `requests:read` for daily viewing. Add `requests:cancel` only if this browser should cancel pending requests. A key without that scope still opens the inbox. The cancel button disappears after the API returns 403.

The bootstrap key opens Keys and Audit as well. Issue a narrower key there. The raw key appears once in a dialog and is dropped when the dialog closes. The key list never shows it. Sign out, then sign in with the issued key. Changing the bootstrap key itself is still an edit to `CLIENT_KEYS` and a restart.

A wrong, expired, or revoked key all produce the same unauthorized response. The page says the key was not accepted.

## Attention lists

The inbox loads three lists, using the window you select:

- Pending requests whose Telegram delivery failed.
- Approved requests that are still claimed, and were claimed before the start of the window.
- Pending requests that expire before the end of the window.

A claimed request with no reported result is an unknown external outcome. The page tells you to reconcile the target system. It does not offer a retry, a claim, or a way to mark the action succeeded.

The same page can filter the client's full request list by decision, delivery, and execution status. Opening a row shows the stored proposal, metadata, and event timeline. Metadata was not sent to Telegram and can contain secrets.

`/health` and `/ready` can show a banner. They stay unauthenticated and do not include request data. A gateway that is not ready can still be read.
