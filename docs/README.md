# notifications-service docs

1. **[`ARCHITECTURE.md`](ARCHITECTURE.md)** — the email service in diagrams
   (topology, campaign send, SNS event tracking, unsubscribe, recruit alerts,
   data model). **Read this first.**
2. [`EMAIL.md`](EMAIL.md) — SES setup, templates, secrets, SNS webhook,
   unsubscribe / one-click.
3. [`TESTING.md`](TESTING.md) — Playwright E2E + the deploy-after-E2E pipeline.

This Worker shares one D1 database with the main
[`curevanails`](https://github.com/curevanails/curevanails) site; that repo's
`docs/ARCHITECTURE.md` has the platform-wide picture.

Diagrams are [Mermaid](https://mermaid.js.org/) code blocks — rendered natively
by GitHub and most Markdown viewers.
