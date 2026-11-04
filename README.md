# VoxFlow Lead Engine

[![CI](https://github.com/MuhammadFahad-offcl/voxflow-lead-engine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MuhammadFahad-offcl/voxflow-lead-engine/actions/workflows/ci.yml)

An AI agent system that finds local businesses, scores how much they need AI automation (with evidence), writes a personalised Urdu call script, calls them with a Vapi voice agent and books a video call with the founder — all from one dashboard.

Built by [VoxFlow AI Solutions](https://voxflow.agency) with [HazelJS](https://hazeljs.ai) agents. First niche: dental clinics in Lahore.

> **Status:** v1 in development (3–30 Nov 2026). See [`docs/backlog.md`](docs/backlog.md).

## How it works

```
Campaign (niche, city, areas)
  → Discover   Apify Google Maps search, dedupe, ideal-client filter
  → Enrich     website (fetch → Lightpanda), reviews, Perplexity context
  → Score      13 evidence-backed signals → 0–100 → hot / warm / cold
  → Solution   one catalog service matched by pgvector + LLM check
  → Script     Urdu call script from the niche template
  → Approve    founder approves the campaign once (HazelJS durable suspend)
  → Call       Vapi Urdu AI call, max 2 attempts, policy-gated
  → Book       Google Calendar slot booked during the call
  → Log        result, reason and English remarks on the dashboard
```

Read [`docs/architecture.md`](docs/architecture.md) for diagrams and [`docs/adr/`](docs/adr/) for why each choice was made.

## HazelJS features used

`AgentGraph` per lead · `@Agent` / `@Tool` with `requiresApproval` · durable suspend + Agent OS approve/reject · SQL run store via Prisma · Gatekeeper default-deny policies · run timeline · `@hazeljs/testing`. Details in [`docs/hazeljs-submission.md`](docs/hazeljs-submission.md).

## Run it in 5 minutes (demo mode, no API keys)

Requirements: Node 26, pnpm 12, Docker.

```bash
git clone https://github.com/MuhammadFahad-offcl/voxflow-lead-engine.git
cd voxflow-lead-engine
cp .env.example .env          # DEMO_MODE=true is the default
docker compose up -d          # Postgres + pgvector, Lightpanda
pnpm install
pnpm db:migrate && pnpm db:seed
pnpm dev                      # dashboard http://localhost:3000, API http://127.0.0.1:4000
```

Demo mode replaces Apify, Perplexity, the LLM, Vapi and Google Calendar with fake adapters that use fictional clinics from `fixtures/`, so the whole pipeline — including a simulated call and booking — runs offline.

To use real services, set `DEMO_MODE=false` and fill the keys in `.env` (see `.env.example`).

## Scripts

| Command                       | What it does                                                                  |
| ----------------------------- | ----------------------------------------------------------------------------- |
| `pnpm dev`                    | API (http://127.0.0.1:4000) and dashboard (http://127.0.0.1:3000) with reload |
| `pnpm build`                  | compile `packages/shared` and `apps/api`, production build of `apps/web`      |
| `pnpm typecheck`              | TypeScript build mode across all packages, tests included                     |
| `pnpm lint`                   | ESLint (typescript-eslint strict + stylistic, sonarjs)                        |
| `pnpm format`                 | Prettier, rewrites files in place                                             |
| `pnpm knip`                   | unused files, exports and dependencies                                        |
| `pnpm test` / `pnpm test:cov` | Jest tests, without / with a coverage report                                  |

## Project docs

- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md) · [Database](docs/database.md) · [ADRs](docs/adr/)
- [Engineering standards](docs/engineering-standards.md) · [Contributing](CONTRIBUTING.md)
- [Claude Code prompts, cycle by cycle](docs/prompts/)
- [Sprint retrospectives — the development log](docs/retros/)

## Responsible use

The caller says it is an AI assistant, calls only within configured hours, never calls a business more than twice, and honours do-not-call requests immediately. No real lead data is stored in this repository.

## License

MIT
