# Backlog — v1 issues by cycle

Create one GitHub issue per line (use the Feature template). Each names the FR/NFR it implements. Order inside a cycle is the build order.

## Cycle 1 — Scored leads (3–9 Nov 2026)

1. chore: monorepo scaffold (pnpm workspaces: `apps/api`, `apps/web`, `packages/shared`), strict tsconfig, ESLint, Prettier, Knip — NFR-8
2. ci: GitHub Actions — install, typecheck, lint, Knip, test, gitleaks; commitlint; Husky + lint-staged — NFR-5, NFR-8
3. chore: docker-compose (Postgres pgvector, Lightpanda); Prisma 7 config; first migration incl. `CREATE EXTENSION vector` — ADR-0002
4. feat: env config schema (Zod) + DI module with real/fake adapter binding and `DEMO_MODE` — ADR-0007, FR-36
5. feat: seed organization, settings defaults, dental niche profile from `config/niches/dental-clinic.json` — FR-4
6. feat: campaigns API (create, list, get) + search grid size — FR-1, FR-2, FR-3
7. spike: compare 2 Apify actors on one Lahore dental search; update ADR-0010 — FR-5
8. feat: `LeadSourcePort` (Apify + fake), discover step, phone/URL normalization, dedupe, ideal-client filter — FR-5–FR-8
9. feat: `WebReaderPort` (fetch → Lightpanda → unreadable) + extraction of emails, wa.me, socials, widgets, phone type — FR-9, FR-10
10. feat: reviews storage + `WebContextPort` (Perplexity + fake) — FR-11, FR-12
11. feat: `LlmPort` with cost recording and monthly cap; review labelling task — FR-13, FR-33
12. feat: scoring rules (pure) + signals + tiers, with unit tests ≥ 80% — FR-14, FR-15
13. feat: lead `AgentGraph` (enrich → score) with per-lead status, error, retry — FR-32
14. feat: dashboard — campaigns list, new campaign form, lead table with filters + CSV export — FR-30 (part), US-14

## Cycle 2 — Solutions and scripts (10–16 Nov)

1. feat: catalog CRUD + embeddings (`EmbeddingPort`) + pgvector search; seed from `config/catalog/services.json` — FR-16
2. spike: `@hazeljs/rag` pgvector store vs own repository; ADR — FR-16
3. feat: solution agent with catalog/signal validation, retry, `NEEDS_REVIEW`, `NO_STRONG_SIGNAL` — FR-17
4. feat: script agent filling the niche template — FR-18
5. test: eval set of 10 fictional clinics in CI — NFR-9
6. experiment: Haiku 5.5 vs gpt-6-luna on 10 Urdu scripts; record result in ADR-0006 follow-up — FR-18
7. feat: approval agent with durable suspend + approve/reject API + approval screen — FR-19
8. feat: lead detail page (evidence, score breakdown, solution, script) — FR-30 (part)

## Cycle 3 — AI calls, HazelJS submission (17–23 Nov)

1. feat: Settings (calling hours, caps, models, retention) API + page — FR-20, FR-26 (settings part), FR-33
2. feat: Gatekeeper policies (hours, DNC, attempt limit, spend cap, health, campaign approved) — FR-21, FR-23
3. feat: `VoicePort` (Vapi + simulated), caller agent, call dispatcher with idempotency — FR-22
4. feat: Vapi webhook + outcome agent + attempt-2 scheduling + DNC — FR-24, FR-28, FR-29
5. feat: reconciliation loop — FR-28, ADR-0009
6. feat: calls-today page and run timeline view — FR-30, FR-35
7. test: 10 real test calls to own phones; pick transcriber + voice — risk mitigation
8. docs: README, screenshots, demo video; fresh-clone test; tag `v0.3.0`; submit

## Cycle 4 — Booking and operations, v1.0 (24–30 Nov)

1. feat: `CalendarPort` (Google + fake), slot cache, `get-slots` + `book-slot` tool routes — FR-25, FR-26, ADR-0008
2. feat: Send confirmation button (prefilled WhatsApp link) — FR-27
3. chore: Cloudflare Tunnel with 3-path ingress; tunnel health — NFR-5, ADR-0003
4. feat: nightly backup + retention loops; restore test documented — NFR-6, NFR-12
5. feat: weekly funnel and costs pages — FR-31, FR-30 (costs), FR-33
6. feat: daily summary + failure alerts (channel per Q8) — FR-34
7. release: full regression, tag `v1.0.0`
