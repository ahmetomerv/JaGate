---
layout: home

hero:
  name: JaGate
  text: Human approval before your app acts
  tagline: Run one small gateway, send decisions through Telegram, and let each client application perform its own approved action.
  actions:
    - theme: brand
      text: Get started
      link: /guide/getting-started
    - theme: alt
      text: HTTP API
      link: /API

features:
  - title: One gateway, multiple clients
    details: Give each application its own API key. Requests and idempotency keys are scoped to that client.
  - title: Durable decisions
    details: SQLite stores immutable proposals, Telegram delivery state, decisions, and claims across restarts.
  - title: Caller-owned execution
    details: JaGate never runs supplied commands, URLs, or callbacks. The calling app keeps action credentials and does the work.
---

JaGate is a self-hosted approval service for actions such as deploying a site, publishing a post, or starting a maintenance job. Applications in any language use its [HTTP API](/API). Node.js and TypeScript applications can also use the [typed client](/guide/typescript).

The first release runs one Node.js 24 process, one SQLite database, and one Telegram bot connected to one destination chat. Approvers are identified by numeric Telegram user IDs. Read the [trust and recovery guide](/guide/security) before using approvals for consequential actions.

```text
Client app → JaGate HTTP API → SQLite → Telegram approver
Client app ← decision + one claim ← JaGate
Client app → performs its own action → reports the result
```

For a first local test, follow [Get started locally](/guide/getting-started). The example asks for approval before writing a harmless temporary text file.
