# Cycle 1 — Scored leads (3–13 Nov 2026)

**Cycle goal:** from the dashboard, create a "dental clinic, Lahore, DHA + Gulberg" campaign and get a lead table of enriched, scored leads — every point backed by evidence — exportable to CSV. Works fully in `DEMO_MODE=true` and with real Apify/Perplexity/Haiku.

**[YOU] before you start this cycle**

- Docker Desktop running; `docker compose up -d` works.
- `copy .env.example .env` (keep `DEMO_MODE=true` until C1-07).
- Apify account + API token (needed at C1-07). Perplexity API key (C1-10). Anthropic API key (C1-11). Put keys in `.env` yourself.
- Prompt S-1 done (issues exist). Issue numbers: C1-01 #3 · C1-02 #4 · C1-03 #5 · C1-04 #6 · C1-05 #7 · C1-06 #8 · C1-07 #9 · C1-08 #10 · C1-09 #11 · C1-10 #12 · C1-11 #13 · C1-12 #14 · C1-13 #15 · C1-14 #16

Every prompt below starts after **S-2** and ends with **S-5 → S-6**.

---

## C1-01 · chore: monorepo scaffold

Branch `chore/<#>-monorepo-scaffold` · Trace NFR-8, ADR-0001

```text
Issue #<#>: monorepo scaffold. Trace: NFR-8, ADR-0001. Follow the feature skill.

Read first: CLAUDE.md, docs/architecture.md §2–3 (containers, repo layout), docs/engineering-standards.md §1.

Build the empty-but-working skeleton. Nothing else.
1. Root: package.json (private, "packageManager": "pnpm@12.16.1", engines node ">=26"), pnpm-workspace.yaml
   (apps/*, packages/*), tsconfig.base.json, .prettierrc + .prettierignore, eslint.config.mjs, knip.json, jest config.
2. Root scripts: dev, build, typecheck, lint, format, knip, test, test:cov. (db:* scripts come in C1-03.)
3. TypeScript: strict + noUncheckedIndexedAccess + exactOptionalPropertyTypes + noImplicitOverride +
   noFallthroughCasesInSwitch + noPropertyAccessFromIndexSignature + verbatimModuleSyntax.
   HazelJS uses decorators: read the installed @hazeljs/core README / type definitions and enable exactly the
   compiler options it requires (e.g. experimentalDecorators / emitDecoratorMetadata) — do not guess.
   TypeScript version: use the newest version that HazelJS, typescript-eslint and the Jest transformer all support.
   If that is not the latest TypeScript, pin it and write ADR-0012 explaining why (adr skill).
4. ESLint flat config: typescript-eslint strictTypeChecked + stylisticTypeChecked, eslint-plugin-sonarjs recommended,
   rules: no-console error, @typescript-eslint/no-non-null-assertion error, @typescript-eslint/ban-ts-comment error.
5. apps/api: HazelJS app with no HealthModule — HazelJS's built-in GET /health (liveness → { status: "alive",
   timestamp }) and GET /ready (readiness checks). src/main.ts parses API_HOST/API_PORT (default 127.0.0.1:4000)
   and calls startServer(host, port) from src/server.ts; src/main.ts is the only entry point (no worker yet).
   @hazeljs/core is patched for listen(port, host) and cleared health-check timers (ADR-0013). One integration
   test starts the app on 127.0.0.1 with a random port: bound address, GET /health, GET /ready shape.
6. apps/web: Next.js (App Router, TypeScript, Tailwind CSS) with a single page "VoxFlow Lead Engine" that fetches
   /health from the API server-side and shows the status. Dev server bound to 127.0.0.1:3000.
7. packages/shared: exports one Zod schema `HealthResponse` used by both api and web (proves the wiring).
8. `pnpm dev` runs api and web together. README "Scripts" table must match the real scripts.

Acceptance: fresh `pnpm install` then `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` all green;
`pnpm dev` → http://localhost:3000 shows "API: alive".
Do not add any other module, port, adapter, Prisma or Docker work — those are later issues.
Show the plan (≤ 5 bullets + list of files) and wait for "go".
```

---

## C1-02 · ci: GitHub Actions, commitlint, Husky

Branch `chore/<#>-ci-pipeline` · Trace NFR-5, NFR-8

```text
Issue #<#>: CI pipeline and commit hooks. Trace: NFR-5, NFR-8. Follow the feature skill.

1. .github/workflows/ci.yml, job id "ci", on pull_request and push to main:
   checkout → pnpm/action-setup → actions/setup-node (version from .nvmrc, pnpm cache) →
   pnpm install --frozen-lockfile → typecheck → lint → knip → test with coverage → gitleaks (gitleaks/gitleaks-action).
   Add a postgres service container (image pgvector/pgvector:pg17) and DATABASE_URL env now, so integration tests
   from C1-03 run without changing CI again. Use concurrency to cancel superseded runs. Pin action versions.
2. commitlint with @commitlint/config-conventional; allowed scopes are free-form.
3. Husky: commit-msg → commitlint; pre-commit → lint-staged (prettier --write + eslint --fix on staged files).
4. .gitleaks.toml: default rules, allowlist only .env.example.
5. Add a CI badge to README.

Acceptance: a PR with a bad commit message is rejected locally; the CI run on this PR is green.
After merge I will make "ci" a required status check — print the exact gh api command for that at the end
(branch protection on main already requires PRs; keep enforce_admins true).
Show the plan and wait.
```

**[YOU] after merge:** run the command Claude printed so `main` requires a green `ci` check.

---

## C1-03 · chore: Docker, Prisma 7, first migration

Branch `chore/<#>-database` · Trace ADR-0002, docs/database.md

```text
Issue #<#>: database setup. Trace: ADR-0002. Follow the feature and db-change skills.

Read first: prisma/schema.prisma, prisma.config.ts, docs/database.md (whole file), docker-compose.yml.
The schema is already designed — do not redesign it. Only fix what Prisma 7 rejects, and explain each fix.

1. Install prisma (dev, root) and @prisma/client + the PostgreSQL driver adapter Prisma 7 requires
   (check the current Prisma 7 docs for the "prisma-client" generator + adapter setup; do not use the old
   "prisma-client-js" pattern). Add dotenv. Add root scripts db:generate, db:migrate, db:studio
   (db:seed comes in C1-05).
2. Install @hazeljs/agent. Find its Prisma example schema for the SQL durable run store (in node_modules, e.g.
   prisma-schema.example.prisma). Paste those models unchanged into the marked section at the end of
   prisma/schema.prisma.
3. Run `docker compose up -d`. Create the first migration with --create-only --name init, then add by hand,
   exactly as docs/database.md "First migration checklist" says:
   CREATE EXTENSION IF NOT EXISTS vector; the CHECK on "CallAttempt"."attemptNumber" IN (1,2);
   the HNSW cosine index on "Service".embedding. Apply it, then prisma generate.
4. apps/api/src/db/: a Prisma client provider registered in HazelJS DI (one instance per process, disconnect on
   shutdown) and a `withTransaction` helper only if something uses it now (otherwise don't add it).
5. Integration test apps/api/test/db.int.spec.ts against the docker database:
   - extension "vector" exists
   - inserting a CallAttempt with attemptNumber 3 fails
   - inserting two Leads with the same (organizationId, placeId) fails
   Integration tests use a separate database "voxflow_test" (create it in the test setup, migrate deploy).
6. Update README quick start if any command changed.

Acceptance: `pnpm db:migrate` on an empty volume creates all tables; integration tests pass locally and in CI.
Never run migrate reset or db push. Show the plan and wait.
```

---

## C1-04 · feat: env config, logger, DI binding for adapters, demo mode

Branch `feat/<#>-config-di` · Trace ADR-0007, FR-36, NFR-5, NFR-10

```text
Issue #<#>: configuration, logging and adapter binding. Trace: ADR-0007, FR-36, NFR-5, NFR-10. Feature skill.

Read first: .env.example (never .env), docs/architecture.md §8 and §12–13, ADR-0007.

1. apps/api/src/config/env.ts: Zod schema for every variable in .env.example. When DEMO_MODE=false, the keys of
   services already built are required (for now none — use a refine that is easy to extend per service).
   Parse once at startup; on failure print which variables are missing/invalid (names only) and exit 1.
   Export a typed `Env` and register it in DI.
2. Logger: choose HazelJS's built-in logger or pino. Write an ADR (the next free ADR number) with the choice and why.
   JSON lines, level from LOG_LEVEL, a child-logger helper that adds campaignId / leadId / attemptId,
   and a `maskPhone("+923001234567") → "+92*******4567"` helper with unit tests. No console.* anywhere.
3. apps/api/src/adapters/bind.ts: one function that registers, for a port token, the real adapter class or the fake
   adapter class depending on env.DEMO_MODE. Business code must never check DEMO_MODE. Unit test both branches
   with two dummy classes inside the spec file only.
4. Health: register a HazelJS health check with app.registerHealthCheck({ name: "db", check, critical: true })
   (SELECT 1 via Prisma, 1 s timeout) and read it from GET /ready. GET /health stays HazelJS's liveness probe —
   never extend it. Worker and tunnel checks are added in C3-02 / C4-03 — do not stub them.
5. apps/api/src/worker.ts: second entry point that loads env + DI, logs "worker started", and shuts down cleanly on
   SIGINT/SIGTERM. Root `pnpm dev` now runs api + worker + web.

Acceptance: deleting DATABASE_URL from the environment makes the API exit with a clear message;
GET /ready shows the db check healthy; all gates green. Show the plan and wait.
```

---

## C1-05 · feat: seed organization, settings defaults, dental niche, catalog

Branch `feat/<#>-seed` · Trace FR-4, FR-26, FR-33

```text
Issue #<#>: seed data. Trace: FR-4 (niche profile), defaults for FR-20, FR-26, FR-33, ADR-0006. Feature skill.

Read first: config/niches/dental-clinic.json, config/niches/dental-clinic.script.md, config/catalog/services.json,
prisma/schema.prisma (Settings, NicheProfile, Service), docs/prd.md "Lead scoring model" and "Call design".

1. packages/shared/src/settings.ts: Zod schemas + types for every Settings JSON column:
   callingHours { timezone "Asia/Karachi", days, windows [{start,end}], blocked [{day,start,end}] },
   booking { workingDays, start, end, meetingMinutes 30, bufferMinutes 15, maxPerDay 4, horizonDays 7 },
   spendCaps { llmMonthlyUsd 10, apifyDailyUsd, perplexityDailyUsd, vapiDailyUsd },
   llmModels { REVIEW_LABELLING, SOLUTION, SCRIPT, OUTCOME } all "claude-haiku-5-5".
   Ask me for the three daily caps before writing them (suggest values from docs/prd.md cost budget).
2. packages/shared/src/niche.ts: Zod schema for the niche JSON file (idealClient, tiers, signalWeights with the
   13 keys, reviewLabels, premiumAreas, defaultAreas). The schema must reject weights that do not sum to 100.
3. prisma/seed.ts (run with tsx, registered in prisma.config.ts migrations.seed): idempotent upserts of
   Organization "VoxFlow AI Solutions", its Settings, NicheProfile dental-clinic v1 (scriptTemplate = the .md file
   text) and the 10 catalog Services (embedding stays NULL until C2-01). Validate both JSON files with the
   schemas before writing. Running the seed twice changes nothing.
4. Root script db:seed. Integration test: seed twice → exactly 1 org, 1 settings, 1 niche v1, 10 services.

Acceptance: `pnpm db:seed` works on a fresh DB and in CI; gates green. Show the plan and wait.
```

---

## C1-06 · feat: campaigns API

Branch `feat/<#>-campaigns-api` · Trace FR-1, FR-2, FR-3

```text
Issue #<#>: campaigns API. Trace: FR-1, FR-2, FR-3. Feature + hazeljs-conventions skills.

1. packages/shared: CreateCampaignInput { nicheSlug, city, areas: string[] (1–20, trimmed, unique) },
   CampaignSummary { id, city, areas, status, grid: { terms, areas, searches }, foundCount, duplicateCount,
   duplicateRate, filteredCount, createdAt }.
2. apps/api/src/modules/campaigns/: controller (POST /campaigns, GET /campaigns, GET /campaigns/:id),
   service, repository. Use the latest NicheProfile version for the slug. Grid = searchTerms × areas;
   searchCount stored on create. New campaigns start in DISCOVERING.
3. Status transitions live in one pure function `canTransition(from, to)` implementing FR-3's state machine
   (+ PAUSED/FAILED from any active state). Unit-test every allowed and a sample of forbidden transitions.
   Expose POST /campaigns/:id/pause and /resume using it.
4. Errors: unknown niche → 404, invalid body → 400 with Zod issues, illegal transition → 409.
5. Integration tests for each endpoint. Add a REST Client file docs/http/campaigns.http with example requests.

Acceptance: creating "dental-clinic / Lahore / [DHA, Gulberg]" returns searches = 4 × 2 = 8. Show the plan and wait.
```

---

## C1-07 · spike: choose the Apify Google Maps actor

Branch `chore/<#>-apify-actor-spike` · Trace FR-5, ADR-0010

**[YOU] first:** create the Apify account, put `APIFY_TOKEN` in `.env`, keep ~$5 credit.

```text
Issue #<#>: spike — choose the Apify actor. Trace: FR-5, FR-2, FR-11, ADR-0010. Time-box: 2 hours.

Read first: ADR-0010, docs/prd.md FR-2, FR-5–FR-11, "Lead scoring model" (which fields scoring needs).

1. Search the Apify Store docs for Google Maps scraper actors. Propose the 2 best candidates in a table:
   actor id, pricing model and price per 1,000 places, price for reviews, fields returned (place id, phone,
   website, categories, rating, review count, reviews with text/date/owner reply, opening hours), max results
   control, polygon/city-wide search support. Wait for me to pick which 2 to test.
2. Write scripts/spikes/apify-compare.ts (excluded from Knip and the build) that runs ONE search
   "dental clinic" in "DHA, Lahore" with max 20 places and up to 30 reviews each on both actors, then prints:
   run time, cost (from the run's usage), count, % of places with phone / website / reviews / owner replies.
   APIFY_TOKEN comes from the environment — never print it.
3. Save raw results ONLY under data/spikes/ (git-ignored). Real business data must never be committed.
4. Create fictional fixtures with the chosen actor's exact item shape: fixtures/places/dental-lahore.json with
   12 invented clinics (invented names, +9230000000xx numbers, example.com sites, invented reviews in English and
   Roman Urdu covering: unanswered phone, long wait, no online booking, positive). Include 2 that must be filtered
   (a hospital, rating 3.6) and 1 duplicate place id.
5. Update ADR-0010: chosen actor, measured numbers, cost per campaign of 8 searches × 100 results, and whether
   city-wide/polygon search is cheaper (FR-2). Set Status: Accepted after I approve. Add APIFY_ACTOR_ID to the
   comment in .env.example.

Deliverable: the comparison table in the PR description + ADR update + fixtures. No app code.
```

---

## C1-08 · feat: LeadSourcePort, discover step, normalization, dedupe, ideal-client filter

Branch `feat/<#>-discover` · Trace FR-5, FR-6, FR-7, FR-8, FR-33

```text
Issue #<#>: discover step. Trace: FR-5–FR-8, FR-33 (Apify cost), ADR-0007, ADR-0010. Feature skill, test first.

Read first: ADR-0010 (chosen actor), fixtures/places/, docs/architecture.md §5 "Discover", schema Lead/Campaign/CostRecord.

1. packages/shared: `ApifyPlace` Zod schema matching the chosen actor's item (only fields we use; unknown keys
   allowed but ignored). Invalid items are logged (place id only) and skipped, never crash the run.
2. ports/lead-source.port.ts: LeadSourcePort.search({ term, area, city, maxResults }) → { items: ApifyPlace[],
   costUsd }. adapters/lead-source/apify.adapter.ts (apify-client, waits for the run, reads the dataset,
   3 retries with backoff on network errors) and fake.adapter.ts (reads fixtures/places/*.json, filters by area).
   Bind with bind.ts. Adapter spec uses a recorded fixture, no network.
3. Pure functions with full unit tests:
   - normalizePhone(raw) → { e164, type: MOBILE|LANDLINE|UNKNOWN } using libphonenumber-js, region PK
     (Pakistani mobiles are +923…; cover 0300-1234567, 042 35xxxxxx, +92 300 1234567, junk)
   - normalizeUrl(raw) → https URL without tracking params / trailing slash, or null
   - idealClientFilter(place, niche.idealClient, chainCounts) → { pass: true } | { pass: false, reason }
     (private only, rating ≥ 4.0, reviews ≥ 30, exclude name keywords, chain = same normalized name ≥ 3 times)
4. pipeline/discover.step.ts: for each grid search → LeadSourcePort → upsert Lead by (organizationId, placeId);
   existing place → campaign.duplicateCount++ and not re-processed; store rawPlace; apply filter →
   FILTERED_OUT + filterReason; record one CostRecord(APIFY) per search with campaignId.
   Before each search check the Apify daily cap from Settings; if reached, PAUSE the campaign with a reason.
5. scheduler/campaign-runner.ts in the worker, every 10 s: claims one DISCOVERING campaign with an atomic
   UPDATE…RETURNING claim, runs discover, then sets ENRICHING. Idempotent if run twice.
6. Integration test with the fake adapter: the fixture campaign ends with 12 found, 1 duplicate, 2 filtered.

Acceptance: in DEMO_MODE a new campaign reaches ENRICHING with correct counts; with DEMO_MODE=false and a real
token, one 1-area campaign works and its cost shows in CostRecord. Show the plan and wait.
```

---

## C1-09 · feat: WebReaderPort — fetch → Lightpanda → unreadable, and extraction

Branch `feat/<#>-web-reader` · Trace FR-9, FR-10, ADR-0004

```text
Issue #<#>: website reading and extraction. Trace: FR-9, FR-10, ADR-0004. Feature skill, test first.

Read first: ADR-0004, docs/architecture.md §5 "Enrich", dental-clinic.json signal rules for no_online_booking,
whatsapp_link, decision_maker_name, multiple_doctors_services, working_website, active_marketing.

1. ports/web-reader.port.ts: read(url) → { status: READ_FETCH|READ_LIGHTPANDA|UNREADABLE, pages: [{ url, html,
   text }], reason? }.
2. Real adapter:
   - robots.txt check (robots-parser), user agent "VoxFlowLeadEngine/1.0 (+https://voxflow.agency)"
   - homepage + at most one contact page (link whose URL or text matches contact / رابطہ / appointment)
   - plain fetch, 10 s timeout, max 2 MB; visible text (Cheerio, scripts/styles removed) < 200 chars →
     retry through Lightpanda via puppeteer-core connect(LIGHTPANDA_CDP_URL); 403, challenge page, timeout or
     error → UNREADABLE with reason
   - one in-flight request per domain (simple per-domain mutex), 3 retries with backoff on network errors only
3. Fake adapter: serves fixtures/sites/<domain>.html (create 6 fictional sites: booking widget, WhatsApp float
   button, 3 doctors listed, JS-only page with tiny text, blocked page, contact page with email).
4. Pure extraction functions (apps/api/src/pipeline/extract/), each with unit tests on the fixtures:
   emails, whatsappLinks (wa.me, api.whatsapp.com), socialLinks (facebook, instagram, tiktok, youtube, linkedin),
   hasOnlineBooking (known widgets/links: calendly, setmore, oladoc, marham, sehat, "book appointment" forms),
   hasChatWidget (tawk.to, crisp, intercom, whatsapp widgets), doctorNames (Dr./ڈاکٹر patterns), treatmentCount.
   Return evidence strings (the matched text/URL) — scoring needs them.
5. pipeline/enrich.step.ts (website part only): run the reader for leads with a website, store websiteStatus and
   extracted fields on the Lead; leads without website → NONE.
6. Integration test: docker Lightpanda is optional in CI — real-adapter tests use recorded HTML; a manual test
   script documents how to try a real site locally.

Acceptance: all 6 fixture sites produce the expected fields and status. Show the plan and wait.
```

---

## C1-10 · feat: reviews storage and WebContextPort (Perplexity)

Branch `feat/<#>-reviews-context` · Trace FR-11, FR-12

**[YOU] first:** `PERPLEXITY_API_KEY` in `.env`.

```text
Issue #<#>: reviews and business context. Trace: FR-11 (must), FR-12 (should — time-box 2 h). Feature skill.

1. Reviews: from each lead's rawPlace (chosen actor's review fields) store up to the 30 most recent reviews in
   Review (externalId, text, rating, publishedAt, ownerReplied). Author names are NOT stored or logged.
   Idempotent on (leadId, externalId). Unit-test the mapping with the fixture.
2. ports/web-context.port.ts: getContext({ name, area, city, website }) → { summary, facts: { decisionMakerName?,
   runsPaidAds?: boolean, notes[] }, sources[], costUsd }.
   Real adapter: Perplexity Search API — read Perplexity's current API docs for the endpoint, request shape and
   price before coding; one query per lead; parse with Zod. Fake: fixtures/context/*.json.
   Record CostRecord(PERPLEXITY_SEARCH); respect the Perplexity daily cap (pause step + banner flag when reached).
3. enrich.step.ts: only for leads that passed the filter; store Lead.businessContext and decisionMakerName when
   found. A Perplexity failure must not fail the lead — log, leave context empty, continue (FR-12 is "should").

Acceptance: demo campaign leads have reviews and context; one real lead works with a real key.
Show the plan and wait.
```

---

## C1-11 · feat: LlmPort with cost recording and the $10 monthly cap; review labelling

Branch `feat/<#>-llm-port` · Trace FR-13, FR-33, NFR-4, ADR-0006

**[YOU] first:** `ANTHROPIC_API_KEY` in `.env`.

```text
Issue #<#>: LLM port and review labelling. Trace: FR-13, FR-33, NFR-4, ADR-0006. Feature + hazeljs-conventions.

Read first: ADR-0006 (model ids, prices, cap), docs/architecture.md §6, dental-clinic.json reviewLabels.

1. ports/llm.port.ts: complete<T>({ task, system, user, schema: ZodType<T>, maxTokens }) → { data: T, usage,
   costUsd, model }. The model comes from Settings.llmModels[task] — never hard-coded.
2. Real adapter through @hazeljs/ai with Anthropic (check @hazeljs/ai docs for provider setup; if it cannot call
   the Haiku 5.5 model id, use @anthropic-ai/sdk inside the adapter and note it in ADR-0006).
   Price table per model in config (from ADR-0006), cost = tokens × price.
   JSON output: parse with the schema; on failure retry ONCE with the validation errors appended, then throw
   LlmOutputInvalidError.
3. Cap: before each call, month-to-date LLM spend (CostRecord, Asia/Karachi month) + this call's max cost estimate
   must stay ≤ Settings.spendCaps.llmMonthlyUsd, else throw SpendCapReachedError (the step pauses and the
   dashboard shows a banner — expose a GET /costs/status { llm: { spent, cap, blocked } }).
   Every call writes CostRecord(LLM) with leadId/campaignId and token units.
4. Fake adapter: returns recorded responses from fixtures/llm/<task>/<hash of input>.json; missing fixture →
   clear error telling how to record it (a `pnpm llm:record` script that runs the real adapter and saves).
5. Review labelling task: apps/api/src/agents/prompts/review-labelling.md (system prompt as a file).
   One call per lead with all its reviews (ids + text) → [{ reviewId, labels: ReviewLabel[] }] from the niche's
   reviewLabels. Reviews may be English, Urdu or Roman Urdu. Unknown review ids in the output are an error.
   Store labels (add a `labels String[]` column to Review via the db-change skill).

Acceptance: cap test — with cap 0.0001 the second call is refused; labelling fixtures for the demo clinics exist;
one real lead costs < $0.001. Show the plan and wait.
```

---

## C1-12 · feat: scoring rules, signals and tiers

Branch `feat/<#>-scoring` · Trace FR-14, FR-15, NFR-9

```text
Issue #<#>: scoring. Trace: FR-14, FR-15, NFR-9 (≥ 80% coverage). Feature + testing-conventions. TEST FIRST.

Read first: docs/prd.md "Lead scoring model" (authoritative), config/niches/dental-clinic.json signalWeights rules.

1. apps/api/src/scoring/ — pure, no I/O, no DI:
   - LeadFacts type: everything scoring needs (labelled reviews, ownerReplied flags, website status, booking/chat
     flags, doctors/treatments, phone type, whatsapp links, decision maker, area, social/ads, category, reviewCount)
   - one function per signal (13), each returning { key, dimension, points, evidence, sourceUrl?, reviewId? } or
     null. NO EVIDENCE, NO POINTS: a signal without a non-empty evidence string is never returned.
   - scoreLead(facts, weights) → { signals, total, breakdown: { pain, fit, reachability, abilityToPay }, tier }
   - tierFor(total, tiers) → HOT ≥ 70, WARM 45–69, COLD < 45 (thresholds from config)
   Evidence examples: quoted review sentence (≤ 200 chars) with reviewId, the booking-widget check result,
   "Maps category: Dental clinic", the wa.me URL.
2. Tests: for every signal a "gets points" and a "no evidence → no points" case; boundaries 44/45, 69/70;
   maximum possible score = 100; only the 30 most recent reviews count; 1 matching review gives 0 points,
   2 give full points.
3. pipeline/score.step.ts: build LeadFacts from the DB, run scoreLead, replace the lead's Signal rows in one
   transaction, store score, scoreBreakdown, tier, status SCORED.

Acceptance: coverage ≥ 80% for scoring/; demo clinics get the scores you list in the PR description with
their top 3 evidence lines. Show the plan and wait.
```

---

## C1-13 · feat: lead AgentGraph (enrich → score), per-lead status, retry

Branch `feat/<#>-lead-graph` · Trace FR-32, NFR-1, NFR-2, ADR-0001

```text
Issue #<#>: lead pipeline graph. Trace: FR-32, NFR-1, NFR-2, ADR-0001. Feature + hazeljs-conventions.

Read first: @hazeljs/agent docs for AgentGraph, function nodes, conditional edges and the SQL durable run store
(installed in C1-03). Use the real API — show me the doc snippet you rely on in the plan.

1. pipeline/lead.graph.ts: one graph run per lead: enrich (website → reviews → context) → label reviews → score →
   END. Conditional edge after score: COLD → END (stays SCORED). Cycle 2 will add solution and script nodes after
   score — leave no placeholder nodes.
2. Durable runs in Postgres (SQL run store). Store the run id on Lead.graphRunId.
3. Failure handling: a node error sets Lead.status FAILED, failedStep, error (message only) and never stops the
   campaign or other leads. SpendCapReachedError pauses instead of failing.
4. scheduler/lead-runner.ts (worker, every 10 s): claims up to N (setting, default 3) leads in DISCOVERED/
   retry-requested state with an atomic claim and runs their graph; when no lead of a campaign is still running
   or pending, the campaign moves ENRICHING → SCORING; it stays in SCORING until Cycle 2 adds scripting.
5. POST /leads/:id/retry → re-queues a FAILED lead from its failedStep.
6. Integration test with all fakes: demo campaign → every lead SCORED, FILTERED_OUT or FAILED (inject one failing
   site) and the campaign is not FAILED. Restart test: kill the worker mid-run, restart, no lead processed twice.

Acceptance: `pnpm dev` in DEMO_MODE, create a campaign via the REST file → all leads scored within 1 minute.
Show the plan and wait.
```

---

## C1-14 · feat: dashboard — campaigns, new campaign, lead table, CSV

Branch `feat/<#>-dashboard-leads` · Trace FR-30 (part), FR-32, FR-33, US-14

```text
Issue #<#>: first dashboard pages. Trace: FR-30 (campaigns, new campaign, lead table + CSV), FR-32 (retry button),
FR-33 (cap banner), NFR-3, NFR-13. Feature skill. Use the frontend-design approach: clean, dense, readable.

1. API (apps/api): GET /campaigns/:id/leads?tier=&status=&area=&minScore=&sort=score|name|reviews&dir=&page=
   (page size 50) and GET /campaigns/:id/leads.csv (all filtered rows; columns: name, area, phone, phone type,
   website, rating, reviews, score, tier, top 3 evidence, status). Response types from packages/shared.
2. apps/web (Next.js App Router, server components fetching the API at 127.0.0.1:4000, Tailwind):
   - /campaigns: table of campaigns with status badge, searches, found, duplicates %, filtered, progress
   - /campaigns/new: form (niche select, city, areas multi-input with the niche's defaultAreas as quick picks),
     shows grid size live, submits, redirects to the campaign
   - /campaigns/[id]: summary + lead table with filters, sort, pagination, CSV button; each row expands to show
     score breakdown (4 dimensions) and every signal's evidence; FAILED rows show error + Retry button
   - global banner when GET /costs/status says a cap is reached
   - all times shown in Asia/Karachi
3. Keep components small; no state library; no component library unless you justify it in the plan.
4. Tests: API integration tests for filters/sort/CSV; a few React component tests for the evidence row.

Acceptance (the Cycle 1 deliverable): in DEMO_MODE create "dental-clinic / Lahore / DHA, Gulberg", watch it
progress, filter to HOT, expand a lead to see evidence, export CSV. Page loads < 2 s with 5,000 seeded leads
(add a `pnpm seed:perf` script that inserts fictional leads into the dev DB). Show the plan and wait.
```

---

## Cycle 1 close

Run **S-8** with `<N> = 1`. Record the demo: create campaign → lead table → evidence → CSV. Tag `v0.1.0`.
