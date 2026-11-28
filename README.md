# VoxFlow Lead Engine

[![CI](https://github.com/MuhammadFahad-offcl/voxflow-lead-engine/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/MuhammadFahad-offcl/voxflow-lead-engine/actions/workflows/ci.yml)

An AI agent system that finds local businesses, scores how much they need AI automation (with evidence) and picks the one catalog service that fits each warm or hot lead (or marks the lead as having no strong signal or needing review), all from one dashboard. Writing an Urdu call script, calling the business with a Vapi voice agent and booking a video call with the founder are on the [roadmap](#roadmap); they are not built yet.

Built by [VoxFlow AI Solutions](https://voxflow.agency) with [HazelJS](https://hazeljs.ai) agents. First niche: dental clinics in Lahore.

> **Status:** in development. Cycle 1 (scored leads) shipped as `v0.1.0`. Cycle 2 (solutions and scripts, planned for 14–20 Nov 2026) is still open: the solution step is on `main`, the script and approval steps are not. Cycles 3 and 4 (calls, booking) have not started, so the plan of v1 by 4 Dec 2026 has slipped. No business has been called. See [`docs/backlog.md`](docs/backlog.md).

## How it works

```
Campaign (niche, city, areas)
  → Discover   Apify Google Maps search, dedupe, ideal-client filter      built
  → Enrich     website (fetch → Lightpanda), reviews, Perplexity context  built
  → Score      13 evidence-backed signals → 0–100 → hot / warm / cold     built
  → Solution   one catalog service matched by pgvector + LLM check        built
  → Script     Urdu call script from the niche template                   Roadmap (#20)
  → Approve    founder approves the campaign once                         Roadmap (#23)
  → Call       Vapi Urdu AI call, max 2 attempts, policy-gated            Roadmap (#26–#29)
  → Book       Google Calendar slot booked during the call                Roadmap (#33)
  → Log        call result, reason and English remarks on the dashboard   Roadmap (#28, #30)
```

What runs today: the dashboard creates a campaign, the worker discovers and enriches its leads, scores them, and runs the solution agent on the warm and hot ones. The dashboard lists campaigns and shows each campaign's lead table with filters and a CSV export.

Read [`docs/architecture.md`](docs/architecture.md) for diagrams and [`docs/adr/`](docs/adr/) for why each choice was made. The architecture document describes the full v1 design, including the parts still on the roadmap.

## HazelJS features used

Only what runs on `main` (HazelJS 2.1.3):

- **`AgentGraph`**: one graph run per lead, nodes website → web context → review labels → score → solution, COLD leads stop after score. [`lead.graph.ts`](apps/api/src/pipeline/lead.graph.ts)
- **SQL durable run store**: `createSqlDurableRunStore` over Prisma records every graph run and its checkpoints (`agent_runs`, `agent_run_checkpoints`). `AgentGraph.execute()` cannot resume in 2.1.3, so a retried lead starts a new run at its next step. [`lead.graph.ts`](apps/api/src/pipeline/lead.graph.ts)
- **`@Agent` / `@Tool` on `AgentRuntime`**: the solution agent, with one tool, `searchCatalog`. [`solution.agent.ts`](apps/api/src/agents/solution.agent.ts)
- **A custom `LLMProvider`**: the agent's model calls go through the monthly LLM spend cap. [`gated-llm.provider.ts`](apps/api/src/llm/gated-llm.provider.ts)
- **`@hazeljs/testing`**: `describeAgent` and `bindAgentSuite` run the real runtime, agent and tool against scripted fictional answers. [`solution.agent.spec.ts`](apps/api/src/agents/solution.agent.spec.ts)
- **`@hazeljs/core`**: modules, DI and controllers ([`app.module.ts`](apps/api/src/app.module.ts)); the `/health` and `/ready` probes are built into `HazelApp` ([`bootstrap.ts`](apps/api/src/bootstrap.ts)).

Details in [`docs/hazeljs-submission.md`](docs/hazeljs-submission.md).

## Quick start (demo mode, no API keys)

Requirements: Git, Node 26, pnpm 12 (Node 26 no longer ships corepack: run `npm install -g corepack` then `corepack enable`, or see [pnpm.io/installation](https://pnpm.io/installation)), Docker Desktop running.

Before `docker compose up -d`, put the same password in `POSTGRES_PASSWORD` and in `DATABASE_URL` in `.env`: Postgres reads it only when its volume is first created.

```bash
git clone https://github.com/MuhammadFahad-offcl/voxflow-lead-engine.git
cd voxflow-lead-engine
cp .env.example .env          # DEMO_MODE=true is the default; set your password now (see above)
docker compose up -d          # Postgres + pgvector, Lightpanda
pnpm install                  # the first install also generates the Prisma client
pnpm db:migrate
DEMO_MODE=true pnpm db:seed   # organization, settings, dental niche, catalog (fake embeddings)
pnpm dev                      # dashboard http://localhost:3000, API http://127.0.0.1:4000, worker
```

**Windows PowerShell:**

- `cp .env.example .env` works in PowerShell (`cp` is `Copy-Item`). Edit `.env` with any editor.
- Set a variable for the rest of that window: `$env:DEMO_MODE = "true"; pnpm db:seed`. The `DEMO_MODE=true pnpm …` form is bash only.
- Windows PowerShell 5.1 has no `&&`; run the commands one per line, or use PowerShell 7.
- Docker Desktop must be started before `docker compose up -d`.
- If `pnpm knip` crashes with an `ArrayBuffer` error, run `$env:KNIP_DISABLE_RAW_TRANSFER = "1"; pnpm knip`.

**Start a demo campaign:**

1. Open http://localhost:3000 and choose **New campaign**.
2. Niche: dental clinic. City: Lahore. Areas: **DHA** only. DHA is the area whose fictional clinics have recorded answers for every step; an area with no fixtures pauses the campaign.
3. Create it. Within about a minute the worker discovers the clinics, then enriches, labels and scores them, and runs the solution agent on the WARM ones. The campaign page refreshes itself every 10 seconds while the worker runs.
4. The chosen services are stored but not shown on the dashboard yet (lead detail page, #24). Open `pnpm db:studio` and look at the `Solution` table: five of the six WARM clinics get a row; the sixth shows `NO_STRONG_SIGNAL` as its status in the lead table.

Each fictional clinic is stored once, so a second DHA campaign finds only duplicates. To run the demo again from empty, use option 2 under [Change the database password](#change-the-database-password) (it deletes all data), then the seed again.

Demo mode replaces Apify, the website reader, Perplexity (search and embeddings) and the LLM with fake adapters. They use the fictional clinics in `fixtures/` and model answers recorded once, so discover → enrich → score → solution runs offline. There are no voice or calendar adapters yet, so nothing is called or booked, in demo mode or otherwise. The fake adapters still write fictional `CostRecord` rows, which count toward the spend caps and show in `pnpm db:studio`; no money is spent. The demo has no HOT lead: the fictional clinics have too few reviews for the review signals.

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
| `pnpm dev`                    | API (http://127.0.0.1:4000), worker and dashboard (http://127.0.0.1:3000) |
| `pnpm build`                  | compile `packages/shared` and `apps/api`, production build of `apps/web`  |
| `pnpm typecheck`              | TypeScript build mode across all packages, tests included                 |
| `pnpm lint`                   | ESLint (typescript-eslint strict + stylistic, sonarjs)                    |
| `pnpm format`                 | Prettier, rewrites files in place                                         |
| `pnpm knip`                   | unused files, exports and dependencies                                    |
| `pnpm test` / `pnpm test:cov` | Jest tests, without / with a coverage report; need Postgres running       |
| `pnpm db:migrate`             | apply migrations, then regenerate the Prisma client (`prisma generate`)   |
| `pnpm db:seed`                | seed the organization, settings, dental niche and catalog; re-run is safe |
| `pnpm seed:perf`              | add 5,000 fictional scored leads to time the dashboard (NFR-3); safe      |
| `pnpm db:generate`            | write the client to `apps/api/src/generated/`; `db:migrate` also runs it  |
| `pnpm db:studio`              | browse the database in Prisma Studio                                      |
| `pnpm read-website <url>`     | try the real web reader on one live site; prints counts, writes nothing   |
| `pnpm llm:record`             | **costs money:** record the demo clinics' labelling answers (see below)   |
| `pnpm llm:record:solution`    | **costs money:** record the WARM demo clinics' solution answers (below)   |

`pnpm llm:record` calls Claude for each fictional demo clinic and saves the answers in `fixtures/llm/`, which demo mode replays. Run it after changing the labelling prompt. It needs `ANTHROPIC_API_KEY` and a seeded, running database. Every call counts toward this month's LLM cap, like any other. It stops before going past `--max-usd` (default 0.10). `--size-check` also prices one 30-review call without saving it. The first recording cost $0.002.

`pnpm llm:record:solution` does the same for the solution agent's answers to the six WARM demo clinics. It builds the clinics in a scratch database (`voxflow_solution_record`, dropped at the end) so the prompts match what the tests replay, and only cost records reach your database. Run it after changing the solution prompt, a signal or the catalog. It prints the model and an estimate first, and stops before any call that could pass `--max-usd` (default 0.10). The first recording cost $0.0035.

After `git pull`, run `pnpm install` and then `pnpm db:migrate`. `pnpm install` updates the dependencies and, when it installs anything, regenerates the Prisma client; when nothing changed, pnpm skips it. `pnpm db:migrate` applies new migrations and always regenerates the client, because Prisma 7 does not do that on its own. So the pair always leaves the client in step with the schema.

## Known limitations

- **Spend caps can be passed slightly.** The Perplexity daily cap (web searches and the solution agent's query embeddings, one shared total) and the monthly LLM cap check the spend, make the call, then record it. Leads running at the same time can each pass the check, so a day or month can end over its cap by the cost of the calls in flight. Tracked in #167. A seed that embeds the catalog with real vectors also counts toward that day's Perplexity cap.
- **A lead graph run cannot resume.** `AgentGraph.execute()` (2.1.3) keeps its state in memory, so a resumed or retried lead starts a new run at its next step. A crash between a paid call and its save repeats that call. Accepted in ADR-0001; no issue.
- **The chosen service is not on the dashboard.** It is stored in `Solution`; the lead detail page is #24.
- **The catalog is read-only.** `GET /services` only; create, edit, retire and the `/catalog` page are #163.
- **Website phones are not extracted.** The `mobile_number` signal reads the listing phone only. #150.
- **Transitive advisories in `basic-ftp`** (through `apify-client`): one high, two moderate in `pnpm audit --prod`. #151.
- **Lightpanda's outbound requests are not pinned** to the checked public addresses, so a DNS-rebinding site could reach the laptop. #94.
- **Database integration tests can fail** on the first full run after an install; a second run passes. #125.
- **Demo data is small.** Only DHA has fixtures for every step, a second DHA campaign is all duplicates, and there is no HOT lead (see the quick start). No issue.

## Roadmap

Not built yet, in backlog order:

- **Script and approval (Cycle 2):** script agent filling the niche template (#20); Haiku 5.5 vs gpt-6-luna on 10 Urdu scripts (#22); eval set of 10 fictional clinics in CI (#21); approval agent with HazelJS durable suspend (`requiresApproval`, `approveAndResume`), approve/reject API and screen (#23); lead detail page (#24); `@hazeljs/rag` spike (#18).
- **Calls (Cycle 3):** Settings API and page (#25); Gatekeeper default-deny call policies (#26); `VoicePort` with Vapi and a simulated adapter, caller agent and dispatcher (#27); Vapi webhook, outcome agent, attempt 2 and do-not-call (#28); reconciliation loop (#29); calls-today page and run timeline (#30); 10 test calls to our own phones (#31).
- **Booking and operations (Cycle 4):** `CalendarPort` with Google Calendar and a fake, `get-slots` and `book-slot` tool routes (#33); Send confirmation link (#34); Cloudflare Tunnel with 3 public paths (#35); backups and retention (#36); funnel and costs pages (#37); daily summary and alerts (#38); `v1.0.0` (#39).

## Contributions to HazelJS

Problems found in HazelJS 2.1.3 while building this. The first two have workarounds here; the third affects the approval agent (#23). None is filed upstream yet.

- **`@hazeljs/agent` cannot be imported without `@hazeljs/eval`.** It lists `@hazeljs/eval` as an optional peer, but `dist/index.js` re-exports `dist/evaluation/agent-eval.js`, which calls `require("@hazeljs/eval")` at the top level. Workaround: we install `@hazeljs/eval` 2.1.3 and use none of it (ADR-0001). _To be filed._
- **`@Agent({ maxSteps })` is ignored.** `AgentRuntime.execute()` takes `options.maxSteps`, else the runtime's `defaultMaxSteps`, else 10; the decorator's value is never read. Workaround: the solution agent passes `maxSteps` to `execute()` ([`solution.agent.ts`](apps/api/src/agents/solution.agent.ts)). _To be filed._
- **`approveAndResume` can run an approved tool twice on the same run.** It never checks that the run is still suspended. Tested with the SQL run store (`durableSuspend: true`, a `requiresApproval` tool that inserts a row, `execute` until the run waits):
  - calling `approveAndResume` a second time, one call after the other, ran the tool twice (2 rows);
  - two approvals in parallel from two processes, with no run lease configured, both ran it (2 rows).

  The source (`acquireRunLease` in `dist/runtime/agent.runtime.js`) suggests that a configured run lease would make the second parallel call fail; that was not tested. We do not use approvals yet; the approval agent (#23) needs its own guard. _To be filed._

## Project docs

- [Product requirements](docs/prd.md)
- [Architecture](docs/architecture.md) · [Database](docs/database.md) · [ADRs](docs/adr/)
- [Engineering standards](docs/engineering-standards.md) · [Contributing](CONTRIBUTING.md)
- [Claude Code prompts, cycle by cycle](docs/prompts/)
- [Sprint retrospectives — the development log](docs/retros/)

## Responsible use

The system does not call anyone yet. The calling rules are requirements for Cycle 3, not code that runs today: the caller says it is an AI assistant, dials only inside calling hours (FR-20), calls a business at most twice (FR-23, ADR-0011), checks policies before every call (FR-21), and adds a number to the do-not-call list the moment someone asks (FR-24).

What runs today reads only public data: Google Maps listings, public websites (robots.txt is respected) and public reviews. Logs mask phone numbers to the last 4 digits and never contain review authors. No real lead data is stored in this repository; the fixtures are fictional.

## License

MIT — see [`LICENSE`](LICENSE).
