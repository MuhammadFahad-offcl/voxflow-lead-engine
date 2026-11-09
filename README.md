# VoxFlow Lead Engine

[![CI](https://github.com/MuhammadFahad-offcl/voxflow-lead-engine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MuhammadFahad-offcl/voxflow-lead-engine/actions/workflows/ci.yml)

An AI agent system that finds local businesses, scores how much they need AI automation (with evidence), writes a personalised Urdu call script, calls them with a Vapi voice agent and books a video call with the founder — all from one dashboard.

Built by [VoxFlow AI Solutions](https://voxflow.agency) with [HazelJS](https://hazeljs.ai) agents. First niche: dental clinics in Lahore.

> **Status:** v1 in development (3 Nov–4 Dec 2026). See [`docs/backlog.md`](docs/backlog.md).

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
cp .env.example .env          # DEMO_MODE=true is the default; set your own POSTGRES_PASSWORD
docker compose up -d          # Postgres + pgvector, Lightpanda
pnpm install                  # the first install also generates the Prisma client
pnpm db:migrate && pnpm db:seed
pnpm dev                      # dashboard http://localhost:3000, API http://127.0.0.1:4000, worker
```

Demo mode replaces Apify, Perplexity, the LLM, Vapi and Google Calendar with fake adapters that use fictional clinics from `fixtures/`, so the whole pipeline — including a simulated call and booking — runs offline.

To use real services, set `DEMO_MODE=false` and fill the keys in `.env` (see `.env.example`).

### Change the database password

Postgres reads `POSTGRES_PASSWORD` only when its volume is first created, so changing it in `.env` does not change the password of a database that already exists. Apply a new password in one of two ways:

1. **Keep the data.** Set the database's password, then put the same one in both `POSTGRES_PASSWORD` and `DATABASE_URL` in `.env`:

   ```bash
   docker compose exec postgres psql -U voxflow -d voxflow -c "\password voxflow"
   ```

   `\password` asks for the new password twice and sends it hashed, so it stays out of your shell history and the Postgres log.

2. **Start from an empty database.** This **deletes all data** in it. Update both lines in `.env` first, then:

   ```bash
   docker compose down -v
   docker compose up -d
   pnpm db:migrate
   ```

## Scripts

| Command                       | What it does                                                              |
| ----------------------------- | ------------------------------------------------------------------------- |
| `pnpm dev`                    | API (http://127.0.0.1:4000), worker and dashboard (http://localhost:3000) |
| `pnpm build`                  | compile `packages/shared` and `apps/api`, production build of `apps/web`  |
| `pnpm typecheck`              | TypeScript build mode across all packages, tests included                 |
| `pnpm lint`                   | ESLint (typescript-eslint strict + stylistic, sonarjs)                    |
| `pnpm format`                 | Prettier, rewrites files in place                                         |
| `pnpm knip`                   | unused files, exports and dependencies                                    |
| `pnpm test` / `pnpm test:cov` | Jest tests, without / with a coverage report; need Postgres running       |
| `pnpm db:migrate`             | apply migrations, then regenerate the Prisma client (`prisma generate`)   |
| `pnpm db:seed`                | seed the organization, settings, dental niche and catalog; re-run is safe |
| `pnpm db:generate`            | write the client to `apps/api/src/generated/`; `db:migrate` also runs it  |
| `pnpm db:studio`              | browse the database in Prisma Studio                                      |

After `git pull`, run `pnpm install` and then `pnpm db:migrate`. `pnpm install` updates the dependencies and, when it installs anything, regenerates the Prisma client; when nothing changed, pnpm skips it. `pnpm db:migrate` applies new migrations and always regenerates the client, because Prisma 7 does not do that on its own. So the pair always leaves the client in step with the schema.

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
