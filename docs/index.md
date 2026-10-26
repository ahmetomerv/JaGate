---
layout: home

hero:
  name: JaGate
  text: Human approval before your app acts
  tagline: Run one small gateway, send decisions through Telegram, and let each client application perform its own approved action.
  image:
    src: /logo.svg
    alt: JaGate logo
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: HTTP API
      link: /API

features:
  - title: Caller-owned execution
    details: JaGate never runs supplied commands, URLs, scripts, or callbacks. The calling application acts with its own credentials.
  - title: Telegram decisions, no public URL
    details: One bot delivers each client's requests to its own chat. Only allowlisted numeric user IDs can decide, and long polling works behind NAT.
  - title: Durable lifecycle and one claim
    details: SQLite stores proposals, delivery state, decisions, claims, and reported outcomes across restarts. Pending requests fail closed on expiry.
  - title: Scoped keys and audit
    details: Issue keys for specific operations with optional expiry, revoke them without restarting, and see which key created, claimed, or reported a request.
  - title: Request history
    details: Filter and page a client's requests, surface failed delivery or old claims, and inspect each request's recorded timeline.
  - title: Operator console and client tooling
    details: Review one client's inbox, timeline, keys, and audit feed in the browser. Build callers with the playground and the HTTP or TypeScript client.
---

JaGate is a self-hosted approval service for actions such as deploying a site, publishing a post, or starting a maintenance job. Applications in any language use its [HTTP API](/API). Node.js and TypeScript applications can also use the [typed client](/guide/typescript).

A gateway runs one Node.js 24 process, one SQLite database, and one Telegram bot. Each client has its own destination chat and allowlist of numeric Telegram user IDs. Read the [trust and recovery guide](/guide/security) before using approvals for consequential actions.

```text
Client app → JaGate HTTP API → SQLite → Telegram approver
Client app ← decision + one claim ← JaGate
Client app → performs its own action → reports the result
```

For a first local test, follow [Get started locally](/guide/getting-started). The example asks for approval before writing a harmless temporary text file. Then use the [scenario guides](/guide/scenarios) for deployment, backup deletion, and claimed-request recovery.
