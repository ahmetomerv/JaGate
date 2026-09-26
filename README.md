# JaGate

Self-hosted human approval gateway

[![Documentation](https://img.shields.io/badge/docs-JaGate-111111)](https://ahmetomerv.github.io/JaGate/) [![License: MIT](https://img.shields.io/badge/license-MIT-brightgreen)](LICENSE) [![Verify and publish docs](https://github.com/ahmetomerv/JaGate/actions/workflows/pages.yml/badge.svg)](https://github.com/ahmetomerv/JaGate/actions/workflows/pages.yml)

Read the [**JaGate documentation**](https://ahmetomerv.github.io/JaGate/) for setup, configuration, the HTTP API, and the TypeScript client.

### Features

- **Caller-owned actions.** An application submits what it wants to do. After approval, that application performs the action with its own credentials.
- **Telegram decisions.** A dedicated bot delivers each request to one chat. Only allowlisted numeric user IDs can approve or reject it.
- **One process.** This release runs Node.js 24, SQLite, and a single Telegram bot.
- **Separate clients.** Each application has its own API key, destination chat, and approver list.
- **Any language.** Use the HTTP API, or the included TypeScript client.
- **Durable state.** Proposals, delivery, decisions, and claims are stored in SQLite and survive restarts.

For the full picture, see the [documentation](https://ahmetomerv.github.io/JaGate/).

## Usage

1. Create a dedicated Telegram bot and note the numeric chat and approver IDs.
2. Copy `.env.example` to `.env`, set the client key, bot token, and routes, then start the gateway.
3. Submit a request, wait for the Telegram decision, then claim it and run the action in your application.

```text
Client app → JaGate HTTP API → SQLite → Telegram approver
Client app ← decision + one claim ← JaGate
Client app → performs its own action → reports the result
```

- [Get started locally](https://ahmetomerv.github.io/JaGate/guide/getting-started.html)
- [Docker Compose](https://ahmetomerv.github.io/JaGate/guide/docker.html)
- [HTTP API](https://ahmetomerv.github.io/JaGate/API.html)
- [TypeScript client](https://ahmetomerv.github.io/JaGate/guide/typescript.html)

## Developing

Follow the [local setup guide](https://ahmetomerv.github.io/JaGate/guide/getting-started.html). Node.js 24.21.0 is required. From the repository root, `npm ci` then `npm run verify` runs typecheck, tests, lint, the server build, and the docs build.

`npm run demo:fake` walks through one approval with an in-memory database and a fake Telegram transport.

`npm run playground` opens a local Vue test console for idempotency, cancellation, expiry, claims, client isolation, and real Telegram integration. See the [playground guide](docs/guide/playground.md).

For a configured local gateway, run `npm run build` followed by `npm run start:local`; the latter loads `.env` without changing the production `npm start` command.

## Contributing

Create a branch, add commits, and [open a pull request](https://github.com/ahmetomerv/JaGate/compare).

Read [`CONTRIBUTING`](CONTRIBUTING.md) for the process, and keep behavior changes reflected in [`docs/`](docs/).

## Continuous Integration

GitHub Actions verifies the project on pull requests and publishes the documentation site after a successful push to `main`. See the [workflow runs](https://github.com/ahmetomerv/JaGate/actions).

## Changelog

See the [`CHANGELOG`](CHANGELOG.md) file for details.

## License

This project is licensed under the [MIT License](https://opensource.org/licenses/MIT) — see the [`LICENSE`](LICENSE) file for details.
