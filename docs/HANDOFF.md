# AI Handoff — VoxFlow Lead Engine

> Last updated: 2026-11-10. For the full project context read `CLAUDE.md`, then `docs/prd.md` and `docs/architecture.md`.

## Cycle 1 issues remaining

Cycle 1 is due **13 Nov 2026**. Issues #3–#11 are closed. Issues #12–#16 remain.

| Issue | Title                                                           | Prompt                                         |
| ----- | --------------------------------------------------------------- | ---------------------------------------------- |
| #12   | Reviews storage + `WebContextPort` (Perplexity + fake)          | `docs/prompts/cycle-1-scored-leads.md` → C1-10 |
| #13   | `LlmPort` with cost recording and monthly cap; review labelling | `docs/prompts/cycle-1-scored-leads.md` → C1-11 |
| #14   | Scoring rules (pure) + signals + tiers, unit tests ≥ 80%        | `docs/prompts/cycle-1-scored-leads.md` → C1-12 |
| #15   | Lead `AgentGraph` (enrich → score) with per-lead status, retry  | `docs/prompts/cycle-1-scored-leads.md` → C1-13 |
| #16   | Dashboard — campaigns list, new campaign form, lead table + CSV | `docs/prompts/cycle-1-scored-leads.md` → C1-14 |

## Keys still needed

- **#12 (Perplexity):** Fahad adds `PERPLEXITY_API_KEY` to `.env` before starting. Ask him, then check the API starts in real mode (not demo) without reading `.env`.
- **#13 (Anthropic):** Fahad adds `ANTHROPIC_API_KEY` to `.env` before starting. Ask him after #12. This is also the checkpoint: give a summary after #13 and wait for "continue".

## Decisions made in chat (not yet in a doc)

### Apify two-pass design (ADR-0015)

- **Pass 1 (#10, done):** Compass `compass~crawler-google-places` scrapes place metadata. One polygon per area, `maxTotalChargeUsd` ≥ $0.50, results capped at 30 per search.
- **Pass 2 (#12):** Scraperlink fetches the 30 newest reviews per place id. Owned by #12.

### Closed-place filter (#10)

Exclude `CLOSED_PERMANENTLY` and `CLOSED_TEMPORARILY` from results. Included in Compass `excludeClosed: true`. PRD updated.

### Gulberg area polygon (#10)

Box: 74.323–74.363 lon, 31.492–31.532 lat. Fahad accepted a small overlap with Rehmanpura in the north-west corner ("dedupe handles it").

### `no_online_booking` scoring rule (#11)

Evidence = the pages checked (homepage + contact page URLs), stored in `Lead.websiteEvidence.pagesRead`. An unreadable site gives 0 points (no evidence). Website phones count toward `mobile_number` but nothing extracts them yet — that is for #14.

### Review signals (#12 / #14)

Only the 2 most recent of the last 30 reviews per place are labelled by the LLM. The labels become scoring signals.

### Spend caps

- Apify: $2.00/day (Asia/Karachi day), stored in `Organization.apifyDailyUsd`.
- Monthly LLM: $10, stored in `Settings.llmMonthlyBudgetUsd`.
- Cycle 1 real-service total budget: $5. Spent so far: ~$1.39 ($0.66 spike + $0.7208 DHA run). About **$3.61 remaining**.

### PR size

1–4 PRs per issue, each under 400 changed lines (excluding `pnpm-lock.yaml` and generated files). Split only where a reviewer would. The rule can be bent when a natural split still puts one PR over 400 (as happened with #11 at 10 PRs).

### #11 decisions (2026-11-10)

- `Lead.websiteEvidence Json?` column added; Zod schema `WebsiteEvidence` in `packages/shared`.
- UNREADABLE reason is logged (fixed text, not page content) and stored in `websiteEvidence.unreadableReason`.
- `decisionMakerName` = first doctor found (homepage, then contact page). Fahad accepted this heuristic.
- Lightpanda DNS-rebinding risk accepted for v1; recorded in ADR-0004; to be fixed after v1 in #94.

## The workflow (every issue)

1. Read the issue prompt in `docs/prompts/cycle-1-scored-leads.md` and the FRs it names in `docs/prd.md`.
2. Restate your plan in ≤ 5 bullets. **If the plan is unambiguous and stays inside the prompt, start without waiting.** If anything needs Fahad's input, stop and ask.
3. Branch: `feat/<issue>-<slug>`.
4. Write tests first for rules and adapters, then the code.
5. Run `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` — all green before you say done.
6. Use the `reviewer` agent before opening PRs.
7. Open PRs with the template in `.github/pull_request_template.md`. Filled: summary, FR/NFR/ADR ids, how tested, risks.
8. **Fahad merges. Never merge yourself.**
9. After every merge to `main`: `pnpm install`, `pnpm db:migrate`, `pnpm test` (Docker Desktop must be running).

### Checkpoints

- **After #13:** give a summary (what was built, what is next) and wait for "continue".
- **After #16:** run the S-8 cycle close but do not tag until Fahad approves.

## What "stop and ask" means

Stop and ask Fahad (never guess) when:

- An issue needs Docker running (#5), Apify account/token (#9), Perplexity key (#12), or Anthropic key (#13).
- Anything would change the PRD, an ADR, the database schema, or scope beyond the issue's prompt.
- Real money is involved: each real-service test must stay under $1, the whole cycle under $5.

**Never:** skip or weaken gates, push to main, force-push, read any `.env` file, make phone calls, or build anything outside v1 (see CLAUDE.md "Do not build").

## Stack quick reference

- TypeScript 6.0.3 strict, Node 26, pnpm workspaces: `apps/api` (HazelJS), `apps/web` (Next.js), `packages/shared`.
- PostgreSQL 17 + pgvector in Docker; Lightpanda in Docker.
- Prisma 7 + `@prisma/adapter-pg`. Run `pnpm db:generate` after any schema change.
- Jest with VM modules; integration tests use `createTestDatabase(name)` — a fresh database per spec.
- Gates: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` and `npx prettier --check .`.
