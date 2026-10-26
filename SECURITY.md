# Security policy

JaGate coordinates approval; it never executes caller-supplied commands, URLs, scripts, or callbacks. Suspected vulnerabilities should be reported privately. Do not open a public issue with vulnerability details.

## Report a vulnerability

Use GitHub's private vulnerability reporting for this repository:

https://github.com/ahmetomerv/JaGate/security/advisories/new

If private reporting is unavailable, open a minimal public issue asking for a private contact channel. Do not include details of the vulnerability in that issue.

Please include:

- The affected version, commit, or release.
- The deployment shape: local Node.js process, Docker Compose, or a reverse proxy.
- Steps to reproduce, the observed impact, and relevant logs.
- Whether client keys, the bot token, claim tokens, request content, or the SQLite database may have been exposed.

Never send real client keys, bot tokens, claim tokens, request databases, or production message content. Redact identifiers first.

You will receive an acknowledgement and a private channel for follow-up. Please allow time for a fix and coordinated disclosure before publishing details.

## Supported versions

JaGate is pre-1.0. Security fixes are applied to the latest commit on `main` and to the most recent release once releases exist. Run a current checkout or release.

## Scope

In scope:

- Authentication or authorization bypass.
- Cross-client access to requests, keys, audit events, or timelines.
- Approval, cancellation, claim, or result state bypass.
- Telegram callback spoofing or decisions by someone outside a client's allowlist.
- Leakage of keys, claim tokens, request databases, or other secrets.
- Console or API exposure caused by a JaGate defect.

Out of scope:

- Findings that require an already compromised host, database, bot token, or Telegram account.
- Deliberately exposing the bare HTTP port to an untrusted network instead of using a private network or an authenticated TLS reverse proxy, which the documentation tells you not to do.
- Social engineering and denial-of-service tests against services you do not own.

Read the [security and recovery guide](https://ahmetomerv.github.io/JaGate/guide/security.html) for the trust model, claim semantics, and operational limits.
