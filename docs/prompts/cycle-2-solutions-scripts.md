# Cycle 2 — Solutions and scripts (10–16 Nov 2026)

**Cycle goal:** every warm or hot lead gets exactly one catalog service (with the evidence that justifies it) and a personalised Urdu call script; the founder reviews the campaign once and approves or rejects it. Pending approval survives a restart.

**[YOU] before you start this cycle**
- Cycle 1 merged and tagged `v0.1.0`.
- Answer PRD **Q5** (which services you will really sell): edit `config/catalog/services.json` yourself or tell Claude in C2-01.
- `OPENAI_API_KEY` in `.env` for C2-06 only.
- Issue numbers: C2-01 #17 · C2-02 #18 · C2-03 #19 · C2-04 #20 · C2-05 #21 · C2-06 #22 · C2-07 #23 · C2-08 #24

Every prompt starts after **S-2** and ends with **S-5 → S-6**.

---

## C2-01 · feat: service catalog CRUD, EmbeddingPort, pgvector search
Branch `feat/<#>-catalog` · Trace FR-16, ADR-0006

```text
Issue #<#>: service catalog. Trace: FR-16, ADR-0006 (embeddings pplx-embed-v1-0.6b, 1024 dims). Feature + db-change.

Read first: config/catalog/services.json, schema Service (embedding is Unsupported("vector(1024)")),
docs/database.md, Perplexity's current embeddings API docs (endpoint, request, price) before coding.

1. ports/embedding.port.ts: embed(texts[]) → { vectors: number[][] (1024 each), costUsd }.
   Real: Perplexity embeddings with PERPLEXITY_EMBEDDING_MODEL; Fake: deterministic hash-based unit vectors
   (same text → same vector) so tests are stable. Record CostRecord(PERPLEXITY_EMBEDDINGS).
2. modules/catalog: GET /services, POST /services, PUT /services/:id, POST /services/:id/retire.
   Zod input in packages/shared; fittingSignals must be keys from the niche's signalWeights.
   On create/update embed "name + problem + expectedResult" and write the vector with a parameterised
   $executeRaw (Prisma cannot write Unsupported fields). Retired services are never returned by search.
3. Repository method searchSimilar(queryVector, k = 5) → services ordered by cosine distance (uses the HNSW index;
   show the EXPLAIN in the PR description).
4. Seed: after services are upserted, embed any service whose embedding IS NULL.
5. Dashboard /catalog page: list, add, edit, retire (simple form, English + Urdu name and result fields).
6. Tests: fake embedder determinism, search returns the obviously closest service for 3 handcrafted queries,
   retire hides a service.

Acceptance: `pnpm db:seed` gives all 10 services a vector; /catalog edits re-embed. Show the plan and wait.
```

---

## C2-02 · spike: `@hazeljs/rag` pgvector store vs our own repository
Branch `chore/<#>-rag-spike` · Trace FR-16, ADR-0001 · time-box 2 h

```text
Issue #<#>: spike — HazelJS RAG vs own pgvector repository. Trace: FR-16. Time-box 2 hours. No production code.

1. Read @hazeljs/rag docs and types: does it support an existing PostgreSQL/pgvector table, our 1024-dim
   Perplexity embeddings, cosine distance and filtering out retired rows?
2. Build a throwaway comparison in scripts/spikes/rag-compare.ts: same 3 queries through @hazeljs/rag and through
   CatalogRepository.searchSimilar. Compare: results, lines of code, extra tables it creates, latency.
3. Write ADR-0013 (next free number): options, results table, decision. Criteria: HazelJS judging gives 30% to
   "practical use of HazelJS" — prefer @hazeljs/rag if it works without hacks; otherwise keep our repository and
   say why. If @hazeljs/rag wins, list the exact change for C2-03 in the ADR.
4. Delete the spike script before merge (keep findings in the ADR).
```

---

## C2-03 · feat: solution agent
Branch `feat/<#>-solution-agent` · Trace FR-17, US-5, ADR-0006

```text
Issue #<#>: solution agent. Trace: FR-17, US-5, NFR-9. Feature + hazeljs-conventions + testing-conventions.

Read first: docs/architecture.md §6 (solution-agent row), ADR-0013, @hazeljs/agent docs for @Agent and @Tool,
docs/prd.md FR-17 and "Lead scoring model".

1. agents/solution.agent.ts: an @Agent with ONE tool `searchCatalog` (@Tool) that embeds the lead's top signals'
   evidence and returns the 5 closest active services (id, slug, name, problem, fittingSignals).
   System prompt in agents/prompts/solution.md: pick the ONE service that removes the biggest evidenced pain;
   output only JSON. Model from Settings.llmModels.SOLUTION via LlmPort (cost + cap apply).
2. Output Zod schema in packages/shared: { serviceSlug, reason (one sentence, English, ≤ 200 chars),
   signalIds: string[] (1–4) } OR { noStrongSignal: true, reason }.
3. Validation (pure function, unit-tested): serviceSlug is an active catalog service AND among the 5 retrieved;
   every signalId belongs to this lead; at least one PAIN signal is cited. Invalid → retry once with the errors →
   still invalid → Lead.status NEEDS_REVIEW. noStrongSignal → NO_STRONG_SIGNAL.
4. Add the node to lead.graph.ts after score, only for WARM and HOT. Store Solution (model id recorded).
5. Agent tests with @hazeljs/testing and recorded LLM fixtures: valid pick; invented signal id → retry → valid;
   twice invalid → NEEDS_REVIEW; weak lead → NO_STRONG_SIGNAL.

Acceptance: every HOT/WARM demo clinic ends with a Solution or one of the two exit statuses; cost per lead
recorded. Show the plan and wait.
```

---

## C2-04 · feat: script agent filling the niche template
Branch `feat/<#>-script-agent` · Trace FR-18, NFR-7

```text
Issue #<#>: script agent. Trace: FR-18, NFR-7 (AI disclosure + recording notice). Feature + hazeljs-conventions.

Read first: config/niches/dental-clinic.script.md (its rules comment is binding), docs/prd.md "Call design",
FR-18, NFR-7, architecture §6 script-agent row.

1. A pure renderer renderScript(template, variables) → text; unknown or missing {{variables}} are errors.
2. agents/script.agent.ts (no tools): from the lead, its Solution, signals and Service, the LLM writes ONLY
   evidenceSummary (one short Urdu sentence restating a cited signal's evidence, no numbers, no names of
   reviewers) and may lightly adapt serviceName/expectedResult wording in Urdu. Everything else is filled by code
   (clinicName, doctorName fallback "ڈاکٹر صاحب", founderName from env, meetingMinutes from Settings,
   assistantName from settings or "سارہ" default — ask me). Prompt in agents/prompts/script.md.
   Model from Settings.llmModels.SCRIPT.
3. Validation (pure, unit-tested): no digits or prices except {{meetingMinutes}}, no URLs, no English sentences
   longer than 3 words except brand/service names, the OPENING section contains the AI disclosure and the
   recording notice, each spoken line ≤ 2 sentences. Invalid → retry once → NEEDS_REVIEW.
4. Store Script { nicheVersion, variables, text, model }. Graph node after solution.
5. Campaign transitions: when all leads of a campaign are done, SCORING → SCRIPTING → AWAITING_APPROVAL
   (the approval itself is C2-07; for now stop at AWAITING_APPROVAL).

Acceptance: every demo lead with a Solution has a valid Script; a rendered example is in the PR description.
Show the plan and wait.
```

---

## C2-05 · test: eval set of 10 fictional clinics in CI
Branch `chore/<#>-evals` · Trace NFR-9

```text
Issue #<#>: eval set. Trace: NFR-9. testing-conventions skill.

1. evals/clinics/*.json: 10 fictional clinics covering: strong phone pain, booking pain, unreplied reviews only,
   no website, unreadable site, landline only, premium area, weak lead (should be NO_STRONG_SIGNAL), a hospital
   (filtered), Roman-Urdu-only reviews. Each file has `expect`: tier range, allowed serviceSlugs, must-cite signal
   keys, forbidden content in script (digits, prices, URLs).
2. evals/run.ts: runs each clinic through label → score → solution → script with the real pipeline code and
   prints a pass/fail table. Two modes: `pnpm evals` (recorded LLM fixtures — runs in CI) and
   `pnpm evals --live` (real models, local only, prints total cost; refuses if it would exceed $0.20).
3. Checks: solution slug in catalog and in allowed list; every cited signal exists with non-empty evidence;
   script passes C2-04 validation; no invented facts (every evidenceSummary must share ≥ 1 content word with a
   cited evidence string).
4. Add the evals job to CI. Record live results for both models in fixtures for C2-06.

Acceptance: 10/10 pass in CI. Show the plan and wait.
```

---

## C2-06 · experiment: Haiku 5.5 vs gpt-6-luna for Urdu scripts
Branch `docs/<#>-script-model-experiment` · Trace FR-18, ADR-0006

```text
Issue #<#>: Urdu script model comparison. Trace: FR-18, ADR-0006. No new production code beyond an OpenAI
option in the existing LLM adapter if missing (behind LlmPort; model chosen by Settings).

1. Generate scripts for the 10 eval clinics with claude-haiku-5-5 and with gpt-6-luna (live mode; cost < $0.10 —
   check current OpenAI pricing for gpt-6-luna first and stop if it differs from ADR-0006).
2. Write docs/experiments/script-model.md: for each clinic, version A and version B in random order (keep the key
   in a separate collapsed section), with a rating table for me: naturalness 1–5, correctness 1–5, would-you-say-it
   yes/no.
3. STOP and ask me to rate. After I fill the table, compute averages, update ADR-0006 with the result and set
   the default Settings.llmModels.SCRIPT (seed + settings migration if needed) to the winner.
```

**[YOU]:** read the 20 scripts aloud, rate them honestly. Ask an Urdu-speaking friend for 5 of them if you can.

---

## C2-07 · feat: approval agent with durable suspend, approve/reject API and screen
Branch `feat/<#>-approval` · Trace FR-19, US-8, NFR-2, ADR-0011

```text
Issue #<#>: campaign approval. Trace: FR-19, US-8, NFR-2, ADR-0011. Feature + hazeljs-conventions.

Read first: @hazeljs/agent docs for requiresApproval, durable suspend and Agent OS approveAndResume/reject;
architecture §5 "approval-agent", ADR-0011.

1. agents/approval.agent.ts with one tool queueCampaignCalls({ campaignId }) marked requiresApproval and running
   with durable suspend. When a campaign reaches AWAITING_APPROVAL the worker starts this agent; the run suspends
   and Campaign.approvalRunId stores the run id.
2. When approved, the tool creates attempt 1 for every READY_TO_CALL lead: CallAttempt { attemptNumber 1,
   status SCHEDULED, window MORNING|AFTERNOON alternating to spread load, scheduledAt = next allowed slot from
   Settings.callingHours (pure scheduler function, unit-tested with fixed clocks incl. Friday block),
   idempotencyKey = "<leadId>:1" }. Campaign → CALLING. Calls are NOT placed yet (Cycle 3).
3. API: GET /campaigns/:id/approval (template text, nicheVersion, counts by tier, ≥ 5 sample scripts — highest
   scores first), POST /campaigns/:id/approve { note? }, POST /campaigns/:id/reject { note } (→ PAUSED,
   leads stay scripted). Approve twice = no-op.
4. Dashboard /campaigns/[id]/approval: template, samples with their evidence and service, counts, Approve/Reject
   with note.
5. Tests: restart test — suspend, restart worker and API, approve → attempts created exactly once; reject path;
   double approve; leads that are NEEDS_REVIEW are excluded.

Acceptance: demo campaign → approval screen → approve → N scheduled attempts with sensible PKT times.
Show the plan and wait.
```

---

## C2-08 · feat: lead detail page
Branch `feat/<#>-lead-detail` · Trace FR-30 (lead detail), FR-32, US-6

```text
Issue #<#>: lead detail page. Trace: FR-30, FR-32, US-6. Feature skill.

1. API GET /leads/:id: lead facts, websiteStatus, contact links, reviews (text, rating, date, labels, owner
   replied — no author), signals grouped by dimension with evidence and points, breakdown, tier, solution
   (service + reason + cited signals), script (rendered text + model), attempts (empty for now), status/error.
2. Dashboard /leads/[id]: header (name, area, phone with type, website link, score/tier badge), score breakdown
   bar, evidence list (cited signals highlighted), solution card, script in an Urdu-friendly RTL block
   (dir="rtl", Noto Nastaliq Urdu or a fallback font), reviews tab, retry button when FAILED, "Mark needs review
   resolved" re-queue for NEEDS_REVIEW.
3. Link from the lead table rows.

Acceptance: a HOT demo lead page shows evidence → service → script in one view. Show the plan and wait.
```

---

## Cycle 2 close
Run **S-8** with `<N> = 2`. Demo: campaign → approval screen with sample scripts → approve → scheduled attempts. Tag `v0.2.0`.
