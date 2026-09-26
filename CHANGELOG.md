# Changelog

## Unreleased

- Added a distinct Telegram destination and approver allowlist per client while keeping one bot and long poller. Startup verifies every destination, and callbacks require the client's chat, allowlisted user, and recorded message.
- Added migration `002_delivery_chat.sql`. Pending delivered requests are requeued with new buttons after a destination change or when upgrading from the earlier schema; settled decisions remain unchanged.

## 0.1.0 — 2026-09-24

- Initial self-hosted HTTP approval gateway with SQLite, Telegram long polling, a typed TypeScript client, Docker Compose example, and fake-transport tests. Node.js 24.21.0 LTS is the runtime baseline.
- Named the project and npm package JaGate (`jagate`).
- Expanded automated coverage for lifecycle, API, Telegram transport, restart recovery, and client behavior; added an architecture and SQLite schema overview.
- Added distinct client API keys and owner-scoped request access and idempotency to the initial schema.
- Added a VitePress documentation site with setup, API, client, architecture, and recovery guides, plus GitHub Pages deployment on successful pushes to `main`.
