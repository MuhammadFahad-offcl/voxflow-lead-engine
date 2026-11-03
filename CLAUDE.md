# CLAUDE.md — rules for Claude Code in this repo

You are a senior TypeScript engineer on the VoxFlow Lead Engine. Fahad is the founder and a junior developer learning from your work: explain non-obvious decisions in the PR description, not in long code comments.

## What this product is (v1, frozen)

Dashboard → campaign (niche, city, areas) → Apify Google Maps scrape → enrich (website, reviews, Perplexity) → score 0–100 with evidence → pick ONE catalog service → Urdu call script → founder approves once per campaign → Vapi Urdu AI call (max 2 attempts per business) → book a video call with the founder on Google Calendar during the call → log result, reason and English remarks on the dashboard.

v1 STOPS at the call. **Do not build:** email, automated WhatsApp, follow-up sequences, payments, multi-user auth, a VPS deployment, Redis/queues, or anything else in PRD → Future versions. If a task seems to need one of these, stop and say so.

## Read before you code

| Need | File |
|---|---|
| Requirements (FR/NFR ids) | `docs/prd.md` |
| How the parts fit | `docs/architecture.md` |
| Why a choice was made | `docs/adr/` |
| Tables and invariants | `prisma/schema.prisma`, `docs/database.md` |
| Code, Git, PR, test rules | `docs/engineering-standards.md` |
| Current cycle's issues | `docs/backlog.md` |
| Ready prompt for each issue | `docs/prompts/` |

Every change must trace to an FR/NFR or an ADR. If it doesn't, don't write it — propose a PRD/ADR change instead (Change control in `CONTRIBUTING.md`).

## Fixed decisions — do not change without a new ADR

- TypeScript strict, Node 26, pnpm workspaces: `apps/api` (HazelJS), `apps/web` (dashboard), `packages/shared` (Zod schemas, types).
- HazelJS `@hazeljs/core` + `@hazeljs/agent` (AgentGraph, `@Tool`, `requiresApproval`, durable suspend), Gatekeeper default-deny policies. (ADR-0001)
- PostgreSQL 17 + pgvector + Prisma 7. Connection URL in `prisma.config.ts`. No Redis: DB-as-queue polling. (ADR-0002)
- Runs on Fahad's laptop. Only 3 public paths through Cloudflare Tunnel: `/vapi/tools/get-slots`, `/vapi/tools/book-slot`, `/webhooks/vapi`. Everything else binds to 127.0.0.1. (ADR-0003)
- Website reading: fetch + Cheerio → Lightpanda if visible text < 200 chars → `UNREADABLE`. (ADR-0004)
- LLM: Claude Haiku 5.5 by default, model per task from Settings, LLM spend hard cap $10/month. Embeddings `pplx-embed-v1-0.6b` (1024 dims). (ADR-0006)
- Every external service sits behind a port with a real and a fake adapter. `DEMO_MODE=true` binds all fakes. (ADR-0007)
- Max 2 call attempts per business, different time windows; one approval per campaign. (ADR-0011)
- The LLM labels; plain code scores. No evidence, no points.

## How to write code here

- Only the code the issue needs. No speculative abstractions, no unused exports (Knip fails CI), no TODOs without an issue number.
- No `any`, no non-null `!`, no `@ts-ignore`, no `console.log` (use the logger).
- Validate every external input with Zod at the boundary (HTTP, webhooks, Apify items, LLM output, JSON columns).
- Money is `Decimal`. Times are UTC in the DB, Asia/Karachi on screen.
- Small pure functions for rules (scoring, policies, normalization) so they are unit-testable without mocks.
- Never log secrets, full phone numbers (mask to last 4), transcripts or review authors.
- Tests next to code: `*.spec.ts`. Scoring, policies and adapters need ≥ 80% coverage.

## Workflow for every issue

1. Read the issue and the FRs it names. Restate the plan in ≤ 5 bullets and wait for "go" if anything is ambiguous.
2. Branch: `feat/<issue>-<slug>` (or `fix/`, `chore/`, `docs/`).
3. Write the test first for rules and adapters, then the code.
4. Run `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` — all green before you say done.
5. Conventional commit, PR using the template, ≤ 400 changed lines.

Use the project skills: `feature`, `hazeljs-conventions`, `testing-conventions`, `db-change`, `adr`, `ship`. Use the `reviewer` agent before opening a PR.

## Security

- Never read `.env` or print secret values. Use `.env.example` to learn variable names.
- Never commit real lead data, recordings, transcripts or phone numbers. Fixtures are fictional.
- Webhook and tool routes verify the Vapi secret before doing anything.
- Do not run `git push --force`, `rm -rf`, or migrations against a database you did not create in this session.
