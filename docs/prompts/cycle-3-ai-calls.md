# Cycle 3 — AI calls and HazelJS submission (17–23 Nov 2026)

**Cycle goal:** approved campaigns are called by the Urdu Vapi agent inside calling hours, every call is checked by Gatekeeper policies first, results (result, reason, English remarks) appear on the dashboard, attempt 2 and do-not-call work. Submit to HazelJS on **23 Nov**.

**[YOU] before you start this cycle**
- Cycle 2 merged and tagged `v0.2.0`.
- Vapi account with credit; a phone number in Vapi that can call Pakistani mobiles (imported Twilio/Telnyx number or Vapi number — confirm international calling to +92 works and its per-minute price).
- Answer PRD **Q1** (PTA telemarketing rules) before any call to a real business. Test calls go only to your own phones.
- `VAPI_API_KEY`, `VAPI_PHONE_NUMBER_ID`, `VAPI_WEBHOOK_SECRET` (`openssl rand -hex 32`) in `.env`.
- Issue numbers: C3-01 #25 · C3-02 #26 · C3-03 #27 · C3-04 #28 · C3-05 #29 · C3-06 #30 · C3-07 #31 · C3-08 #32

**Note on webhooks this cycle:** the Cloudflare Tunnel arrives in Cycle 4. In Cycle 3, real test-call results arrive through the **reconciliation loop** (C3-05 polls Vapi's API), and the webhook route is tested with recorded payloads and the simulated voice adapter. That is exactly why ADR-0009 exists.

Every prompt starts after **S-2** and ends with **S-5 → S-6**.

---

## C3-01 · feat: settings API and page
Branch `feat/<#>-settings` · Trace FR-20, FR-26, FR-33, NFR-6, ADR-0006

```text
Issue #<#>: settings. Trace: FR-20 (calling hours), FR-26 (booking), FR-33 (caps), NFR-6 (retention),
ADR-0006 (models per task). Feature skill.

1. modules/settings: GET /settings, PUT /settings (partial update, validated with the packages/shared schemas
   from C1-05; reject windows that overlap or end before they start; caps ≥ 0; retentionDays 7–365).
   Every change writes an audit line to the log (old → new, no secrets).
2. Dashboard /settings with sections: Calling hours (days, windows, blocked periods — PKT), Booking, Spend caps
   (with month-to-date and today's spend next to each cap), Models per task (select from the price table in
   config), Retention. Save per section.
3. All existing readers of Settings (caps, scheduler) read fresh values (no restart needed); cache at most 30 s.

Acceptance: change calling hours on the page → C2's scheduler uses them for new attempts. Show the plan and wait.
```

---

## C3-02 · feat: Gatekeeper policies and health
Branch `feat/<#>-policies` · Trace FR-21, FR-23, FR-24, FR-22 (health), NFR-7, NFR-10

```text
Issue #<#>: call policies. Trace: FR-21, FR-23, FR-24, FR-22 (health gate), NFR-7, NFR-10. Feature +
hazeljs-conventions + testing-conventions. TEST FIRST.

Read first: docs/architecture.md §7 (policy table — authoritative), @hazeljs/agent-gatekeeper docs
(default-deny, how a policy returns allow/deny with a reason), ADR-0011.

1. apps/api/src/policies/: one pure function per policy (calling-hours, do-not-call, attempt-limit, spend-cap,
   health, campaign-approved) taking a PolicyContext { now, settings, phone, placeId, dialledAttemptsForPlace,
   dialledAttemptsForPhone, dnc, spend, health, campaignStatus } → { allow: true } | { allow: false, policyId,
   reason }. attempt-limit counts across ALL campaigns, by place id AND by phone.
2. Wire them into Gatekeeper as default-deny rules for the placeCall tool (C3-03 uses it). A denied call stores
   CallAttempt.status DENIED + deniedBy; calling-hours/spend-cap/health denials reschedule instead of killing the
   attempt (next allowed slot), DNC/attempt-limit/campaign-approved are final.
3. Health: the worker writes a heartbeat (use the db-change skill: add a small WorkerHeartbeat table or propose a
   better place — explain). Register a HazelJS health check "worker" (critical; healthy if heartbeat < 60 s) and
   read it from GET /ready — never extend GET /health; tunnel is added in C4-03. health policy denies when the db
   or worker check is unhealthy.
4. Tests: boundaries 09:59/10:00/12:59/13:00/14:59/15:00/17:59/18:00 PKT, Friday 12:30–15:00, Sunday, attempt 2
   allowed / attempt 3 denied, DNC by exact E.164, cap exactly reached. Coverage ≥ 80% for policies/.

Acceptance: a policy table test file reads like the architecture table. Show the plan and wait.
```

---

## C3-03 · feat: VoicePort (Vapi + simulated), caller agent, call dispatcher
Branch `feat/<#>-calling` · Trace FR-22, FR-20, NFR-1, NFR-7

```text
Issue #<#>: placing calls. Trace: FR-22, FR-20, NFR-1, NFR-7, ADR-0007. Feature + hazeljs-conventions.

Read first: Vapi's current API docs (create call, get call, assistants, transcriber languages for Urdu,
variableValues, metadata, server URL, idempotency) — quote the endpoints you use in the plan.
docs/prd.md "Call design", config/niches/dental-clinic.script.md, architecture §10.

1. config/vapi/assistant.json (versioned in Git, no secrets): Urdu transcriber, voice, first message =
   OPENING with AI disclosure + recording notice, system prompt template that embeds the lead's rendered script
   and the branch rules, end-call phrases, max duration 5 min, voicemail detection → hang up, structured output
   / analysis plan that returns the fields C3-04 needs. scripts/vapi-sync.ts creates or updates the assistant from
   this file and prints its id (I put it in .env as VAPI_ASSISTANT_ID). Leave the tools (get-slots/book-slot)
   out until C4-01.
2. ports/voice.port.ts: createCall({ attemptId, phone, variables }) → { vapiCallId }, getCall(vapiCallId) →
   normalized result. Real: Vapi REST with idempotency key = attempt.idempotencyKey, 3 retries.
   Fake (simulated): returns an id, then after a delay POSTs a recorded end-of-call payload to the API's webhook
   route (fixtures/vapi/*.json: booked-intent, no-answer, not-interested, DNC, wrong number, callback).
3. agents/caller.agent.ts with tool placeCall guarded by the C3-02 Gatekeeper policies.
4. scheduler/call-dispatcher.ts (every 30 s): claims due SCHEDULED attempts atomically (SCHEDULED → DIALING
   only if policies allow), max 1 concurrent call (setting), records Vapi cost later from the result.
   A crash between claim and createCall must not dial twice (idempotency key) — test it.
5. Tests: simulated full flow in DEMO_MODE; dispatcher idempotency; denied attempt rescheduled.

Acceptance: in DEMO_MODE an approved campaign's attempts dial in calling hours only and get simulated results.
[YOU] after merge: run vapi-sync, set VAPI_ASSISTANT_ID. Show the plan and wait.
```

---

## C3-04 · feat: Vapi webhook, outcome agent, attempt 2, do-not-call
Branch `feat/<#>-outcomes` · Trace FR-28, FR-29, FR-23, FR-24, NFR-1, NFR-6, NFR-13

```text
Issue #<#>: call outcomes. Trace: FR-28, FR-29, FR-23, FR-24, NFR-1, NFR-13. Feature + hazeljs-conventions.

1. POST /webhooks/vapi: verify the shared secret FIRST (constant-time compare, header name from Vapi docs);
   reject anything else with 401 and no detail. Validate the end-of-call payload with Zod; respond 200 quickly and
   process after (store the raw event id to make processing idempotent on vapiCallId).
   Store transcript, recordingUrl, durationSec, costUsd (CostRecord VAPI), endedAt.
2. agents/outcome.agent.ts (no tools, Settings.llmModels.OUTCOME): from transcript → { result (CallResult),
   reasonCode?, remarks (1–3 English sentences), callbackAt? (ISO, PKT understood), decisionMakerName? }.
   Zod; invalid → retry once → result FAILED with remarks "needs manual review". Never invent a booking: BOOKED
   only if the transcript shows a confirmed slot (Cycle 4) — before C4, "agreed to a meeting" is
   INTERESTED_NOT_BOOKED.
3. Pure function nextStep(attempt, outcome, settings) (unit-tested, ADR-0011):
   NO_ANSWER / NOT_DECISION_MAKER → attempt 2 in the OTHER window on the next allowed day;
   CALLBACK_REQUESTED → attempt 2 at callbackAt (clamped into calling hours); attempt already 2 → close;
   DO_NOT_CALL → add DoNotCall(phone) + close; WRONG_NUMBER, NOT_INTERESTED, BOOKED → close;
   FAILED (never rang) → retry same attempt up to 3 times without consuming it.
   Update Lead.status (IN_CALLING / BOOKED / CLOSED).
4. Tests with every fixture payload; replaying the same webhook twice changes nothing; a bad secret is rejected.

Acceptance: in DEMO_MODE each simulated result produces the right next step on the dashboard data.
Show the plan and wait.
```

---

## C3-05 · feat: reconciliation loop
Branch `feat/<#>-reconciliation` · Trace FR-28, NFR-2, ADR-0009

```text
Issue #<#>: reconciliation. Trace: FR-28, NFR-2, ADR-0009. Feature skill.

1. scheduler/reconciliation.ts: on worker start and every 15 min, find attempts DIALING for > 20 min without a
   result → VoicePort.getCall → feed the SAME handler the webhook uses (extract it into one service if needed).
   Calls still in progress are left alone. Vapi errors are logged and retried next run.
2. Tests: webhook-then-reconcile and reconcile-then-webhook both process once; worker restart catches up.

Acceptance: with the API's webhook route disabled, a simulated call still gets its outcome via reconciliation.
This is how real test calls get results until the tunnel exists. Show the plan and wait.
```

---

## C3-06 · feat: calls-today page and run timeline view
Branch `feat/<#>-calls-pages` · Trace FR-30, FR-35, NFR-10

```text
Issue #<#>: operations pages. Trace: FR-30 (calls today), FR-35 (run timeline). Feature skill.

1. /calls: today's attempts in PKT — time, clinic, attempt #, status, result, reason, remarks, duration, cost,
   play recording link, transcript drawer; filters by result; denied attempts show the policy.
2. /campaigns/[id]/timeline: every step, tool call, approval and state change for the campaign and its leads,
   from the HazelJS run timeline (read the @hazeljs/agent timeline API) merged with our status changes,
   newest first, paginated.
3. Lead detail page: show attempts with results and remarks.

Acceptance: after a demo campaign is called, /calls, the timeline and the lead detail page show the same attempts
and results. Show the plan and wait.
```

---

## C3-07 · test: 10 real test calls to your own phones
Branch `docs/<#>-voice-tests` · Trace risk "Urdu voice quality", NFR-7

**[YOU]:** have 2–3 phones ready (yours, family). Never call a real business in this step.

```text
Issue #<#>: real voice tests. Trace: PRD risks (Urdu voice quality), NFR-7.

1. Create a test campaign "TEST — own phones" from a fixture: 5 fictional clinics whose phone numbers I will type
   into the dashboard myself (do not ask me to paste them in chat, do not commit them).
2. Prepare a test matrix docs/experiments/voice-tests.md: 2 transcribers (from Vapi's Urdu-capable list) × 2–3
   voices × scenarios (booked intent, busy/callback, not interested, "don't call again", front desk, silence).
   For each call I fill: understood me (1–5), sounded natural (1–5), latency felt OK (y/n), right result recorded
   (y/n), disclosure heard (y/n).
3. Between runs, change assistant.json and re-run vapi-sync (one change at a time).
4. After I fill the matrix: write an ADR (the next free ADR number) with the chosen transcriber + voice, cost per minute measured, and
   known failure cases; update assistant.json to the winner.
```

---

## C3-08 · docs: README, demo video, fresh-clone test, tag, submit
Branch `docs/<#>-submission` · Trace NFR-11, docs/hazeljs-submission.md

```text
Issue #<#>: HazelJS submission. Trace: NFR-11, docs/hazeljs-submission.md (criteria + checklist).

1. Fresh-clone test: in a new temp folder, clone the repo and follow ONLY the README quick start in DEMO_MODE.
   Time it (must be < 10 min). Fix every step that fails or is unclear.
2. README: screenshots (campaigns, lead detail with evidence, approval, calls), a mermaid architecture diagram,
   "HazelJS features used" with links to the exact files, "Technical decisions" linking ADRs, "Development
   process" linking docs/retros/ and the PR history, cost table, responsible-use section, known limitations.
3. Fill every row of docs/hazeljs-submission.md mapping each judging criterion to evidence in the repo.
4. Write the demo video script (3–4 min): problem → create campaign → evidence → approval → simulated call →
   result → code tour of lead.graph.ts, approval agent, Gatekeeper policies → tests/CI.
5. Tag v0.3.0 with release notes.
[YOU]: record the video, upload unlisted to YouTube, add the link to README, submit the repo at
https://hazeljs.ai/build#submit on 23 Nov.
```

---

## Cycle 3 close
Run **S-8** with `<N> = 3`. Submit to HazelJS. Tag `v0.3.0`.
