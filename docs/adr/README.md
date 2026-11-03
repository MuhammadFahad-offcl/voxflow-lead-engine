# Architecture Decision Records

An ADR records one important decision: the context, the options, what was chosen and what it costs. ADRs are never edited after acceptance; a changed decision gets a **new** ADR that supersedes the old one.

Write a new one with `/adr <title>` in Claude Code, or copy [`template.md`](./template.md).

| # | Decision | Status |
| --- | --- | --- |
| [0001](./0001-hazeljs-typescript-backend.md) | HazelJS + TypeScript for the backend and agents | Accepted |
| [0002](./0002-postgres-prisma-pgvector-no-redis.md) | PostgreSQL + Prisma + pgvector; no Redis in v1 | Accepted |
| [0003](./0003-laptop-hosting-cloudflare-tunnel.md) | Run on the founder's laptop; Cloudflare Tunnel for 3 public paths | Accepted |
| [0004](./0004-tiered-website-reading-lightpanda.md) | Tiered website reading with Lightpanda fallback | Accepted |
| [0005](./0005-v1-call-only-scope.md) | v1 stops at the AI call; no email or automated WhatsApp | Accepted |
| [0006](./0006-llm-haiku-default-per-task-models.md) | Claude Haiku 5.5 default; model is a per-task setting | Accepted |
| [0007](./0007-ports-and-adapters-demo-mode.md) | Ports and adapters with fake adapters and demo mode | Accepted |
| [0008](./0008-calendar-slot-cache.md) | Cached calendar slots; live re-check only on booking | Accepted |
| [0009](./0009-vapi-webhook-reconciliation.md) | Recover missed Vapi webhooks by polling, not a cloud relay | Accepted |
| [0010](./0010-apify-search-grid-caps.md) | Cap Apify results per search; actor chosen in Cycle 1 | Accepted (actor pending) |
| [0011](./0011-call-attempt-and-approval-rules.md) | Max 2 calls per business; one approval per campaign | Accepted |
| [0012](./0012-pin-typescript-6.md) | Pin TypeScript 6.0.3 until the lint and test tools support 7 | Proposed |
| [0013](./0013-patch-hazeljs-listen-host.md) | Patch @hazeljs/core: bind to 127.0.0.1 and clear health-check timers | Proposed |
