# Cycle 4 — Booking and operations, v1.0 (28 Nov–4 Dec 2026)

**Cycle goal:** during the call the AI agent offers two real free slots and books a Google Meet video call on your calendar; you send the confirmation with one click; the system runs reliably on your laptop (tunnel, backups, retention, funnel, alerts). Ship **v1.0.0 on 4 Dec**, live run in December.

**[YOU] before you start this cycle**

- Cycle 3 merged, `v0.3.0` tagged, HazelJS submitted.
- Google Cloud project with the Calendar API enabled and an OAuth client (Desktop app) — Claude will guide you in C4-01.
- Cloudflare account with the `voxflow.agency` domain on Cloudflare DNS (needed for C4-03).
- Decide PRD **Q8** (alert channel) before C4-06.
- Issue numbers: C4-01 #33 · C4-02 #34 · C4-03 #35 · C4-04 #36 · C4-05 #37 · C4-06 #38 · C4-07 #39

Every prompt starts after **S-2** and ends with **S-5 → S-6**.

---

## C4-01 · feat: CalendarPort, slot cache, get-slots and book-slot tool routes

Branch `feat/<#>-booking` · Trace FR-25, FR-26, NFR-3, ADR-0008

```text
Issue #<#>: booking during the call. Trace: FR-25, FR-26, NFR-3, NFR-1, ADR-0008. Feature + hazeljs-conventions.
TEST FIRST for slot maths.

Read first: ADR-0008, architecture §10 (tool route contracts), Google Calendar API docs (freebusy.query,
events.insert with conferenceData createRequest for Meet), Vapi docs for server tools (request/response format,
timeout, secret header).

1. scripts/google-auth.ts: one-time local OAuth flow (loopback redirect on 127.0.0.1) that prints a refresh token
   for me to put in .env. Scope: calendar.events + calendar.freebusy only. Explain each step to me.
2. ports/calendar.port.ts: freeBusy(range) and createEvent({ start, end, title, description }) (no attendees — I invite the clinic myself)
   → { eventId, meetLink }. Real: googleapis; Fake: in-memory calendar with a few busy blocks.
3. Pure slot functions (booking/slots.ts): from booking settings + busy blocks + now → free slots
   (working days/hours PKT, meetingMinutes 30, bufferMinutes 15 around events, maxPerDay 4, horizonDays 7,
   no slot earlier than now + 2 h). Unit tests: buffers, day cap, horizon, DST-free PKT, Friday rules if any.
4. booking/slot-cache.ts: in-memory cache refreshed every 5 min and on every booking; served instantly.
5. Routes (secret-verified first, Zod-validated, p95 < 2 s — add a latency test with the fake):
   POST /vapi/tools/get-slots → the 2 earliest free slots with Urdu spoken labels ("منگل، 25 نومبر، دوپہر 3 بجے")
   and ISO values. POST /vapi/tools/book-slot { attemptId, slotStart } → live freeBusy re-check → createEvent
   (title "VoxFlow × <clinic> — video call", description with the lead summary, evidence and service) →
   Meeting row → { booked: true, spokenConfirmation } or { booked: false, alternatives: next 2 }.
   Idempotent on attemptId + slotStart.
6. Add both tools to config/vapi/assistant.json (server URL = PUBLIC_HOOKS_BASE_URL + path) and update the
   outcome agent: BOOKED only when a Meeting exists for the attempt.

Acceptance: in DEMO_MODE a simulated call books a slot; double booking the same slot is impossible.
Show the plan and wait.
```

---

## C4-02 · feat: Send confirmation button (prefilled WhatsApp)

Branch `feat/<#>-send-confirmation` · Trace FR-27, US-12

```text
Issue #<#>: send confirmation. Trace: FR-27, US-12. Feature skill. Note: this is NOT automated WhatsApp — it only
opens WhatsApp on my computer with a prefilled message; I press send myself (CLAUDE.md "Do not build").

1. Pure function buildConfirmationLink(meeting, lead, founderName) → https://wa.me/<digits>?text=<encoded>,
   message in Urdu + English: greeting, clinic name, date/time PKT, duration, Meet link, "reply here to reschedule".
   Unit tests for encoding and the digits format.
2. On the lead detail page and /calls: "Send confirmation" button for BOOKED leads; clicking opens the link and
   POST /meetings/:id/confirmation-sent sets confirmationSentAt; the button then shows "Sent ✓ <time>".
3. Upcoming meetings list on the dashboard home: next 7 days with clinic, time, Meet link, confirmation state.

Acceptance: booked demo lead → button opens WhatsApp Web with the right text. Show the plan and wait.
```

---

## C4-03 · chore: Cloudflare Tunnel with 3-path ingress and tunnel health

Branch `chore/<#>-tunnel` · Trace NFR-5, NFR-10, ADR-0003

**[YOU]:** install `cloudflared` on Windows (`winget install Cloudflare.cloudflared`), log in, create the tunnel; Claude guides you.

```text
Issue #<#>: public tunnel. Trace: NFR-5, NFR-10, ADR-0003. Explain every command to me before I run it —
I run the cloudflared commands myself in PowerShell.

1. docs/runbook.md "Tunnel": create named tunnel voxflow-hooks, route DNS hooks.voxflow.agency, config.yml
   (stored outside the repo in %USERPROFILE%\.cloudflared, an example with fake ids committed as
   ops/cloudflared/config.example.yml) with ingress: exactly /vapi/tools/get-slots, /vapi/tools/book-slot,
   /webhooks/vapi → http://127.0.0.1:4000; everything else → http_status:404. Install as a Windows service.
2. Defence in depth in the API: requests on those 3 paths need the Vapi secret; all other routes reject requests
   that carry Cloudflare headers (cf-connecting-ip) so nothing else is reachable even if ingress is misconfigured.
   Test it.
3. Health (without adding a 4th public path): the worker checks cloudflared's local metrics endpoint
   (127.0.0.1:<metrics port>, set in config.yml) every minute and stores the result with its heartbeat;
   register it as a HazelJS health check "tunnel" (critical) read from GET /ready — never extend GET /health —
   and include it in the health policy.
4. Update README and .env.example (PUBLIC_HOOKS_BASE_URL). Re-run vapi-sync so tools and webhook use the tunnel.

Acceptance: from my phone's browser (mobile data) /webhooks/vapi without secret → 401, /campaigns → 404;
a real test call to my phone books a slot end to end. Show the plan and wait.
```

---

## C4-04 · feat: nightly backup and retention loops, restore test

Branch `feat/<#>-backup-retention` · Trace NFR-6, NFR-12

```text
Issue #<#>: backup and retention. Trace: NFR-6, NFR-12. Feature skill.

1. scheduler/backup.ts: daily 02:00 PKT (and on start if the last backup is > 24 h old because the laptop slept):
   pg_dump via `docker compose exec` custom format to BACKUP_DIR (Google Drive–synced folder), file name with
   UTC timestamp, keep the last 14, log size. Failure → alert (C4-06) and dashboard banner.
2. scheduler/retention.ts: daily 03:00 PKT: clear CallAttempt.transcript and recordingUrl older than
   Settings.retentionDays (result, reason, remarks stay). Count logged.
3. docs/runbook.md "Restore": exact PowerShell steps to restore a dump into a fresh volume and verify counts.
   Do a real restore test into a temp database and paste the output in the PR.
4. Tests: retention boundary (day 89/90/91), backup rotation keeps 14, catch-up after sleep.

Acceptance: a dump appears in BACKUP_DIR; restore steps work on a clean volume. Show the plan and wait.
```

---

## C4-05 · feat: weekly funnel and costs pages

Branch `feat/<#>-funnel-costs` · Trace FR-31, FR-30 (costs), FR-33, US-15, G-goals

```text
Issue #<#>: weekly funnel and costs. Trace: FR-31, FR-30 (costs), FR-33, US-15, PRD goals. Feature + db-change
skills.

1. "Won" is entered by me: use the db-change skill to add Lead.wonAt (DateTime?) and Lead.wonNote; a
   "Mark as won" action on booked leads.
2. GET /funnel?week=YYYY-Www (PKT weeks, Monday start): scraped, qualified (passed filter), warm+hot, called
   (attempt dialled), answered (any result except NO_ANSWER/FAILED), booked, won — plus conversion % between steps
   and cost per booked meeting.
3. Dashboard /funnel: this week vs last 4 weeks (bar per stage), goal line for 2 clients/month from the PRD.
4. Dashboard /costs: month-to-date and today per service (APIFY, PERPLEXITY_*, LLM, VAPI) vs caps, cost per lead,
   cost per booked meeting, top 10 most expensive leads.

Acceptance: funnel and cost numbers match a hand count on demo data in the PR description. Show the plan and wait.
```

---

## C4-06 · feat: daily summary and failure alerts

Branch `feat/<#>-alerts` · Trace FR-34 (should), NFR-10

```text
Issue #<#>: daily summary and alerts. Trace: FR-34 (should — time-box 3 h), NFR-10.
Channel = my answer to PRD Q8: <write it here: "Telegram bot to me" or "Windows desktop notifications">.
This sends messages ONLY to me, the founder — never to leads (CLAUDE.md "Do not build").

1. ports/notifier.port.ts with the chosen real adapter + a fake that writes to the log.
2. Daily 19:00 PKT summary: today's calls, results, bookings (with times), spend vs caps, failures, tomorrow's
   scheduled attempts. Immediate alerts (deduplicated, max 1 per type per hour): worker down, tunnel down,
   backup failed, cap reached, 3+ consecutive FAILED calls.
3. Settings toggle for each alert type.

Acceptance: in DEMO_MODE the summary appears in the log; with real config I receive it. Show the plan and wait.
```

---

## C4-07 · release: full regression and v1.0.0

Branch `chore/<#>-release-v1` · Trace NFR-1–NFR-13, PRD release plan

```text
Issue #<#>: v1.0 release. Trace: all NFRs, PRD "Release plan".

1. Regression checklist docs/release/v1.0-checklist.md generated from every FR/NFR with how it was verified
   (test name, manual step or screenshot). Run every automated suite and the evals.
2. End-to-end in DEMO_MODE from a fresh clone (README only, < 10 min), then a real run: one small campaign
   (1 area) on real services up to AWAITING_APPROVAL — I decide whether to approve real calls (Q1 answered?).
3. Fix only release blockers; list everything else as issues for v1.1 in the "Future versions" milestone.
4. CHANGELOG.md for v0.1.0 → v1.0.0 from merged PRs. Tag v1.0.0 with release notes.
5. docs/runbook.md "Daily operation": start/stop, what to check each morning, what to do when a cap/alert fires.
```

---

## Cycle 4 close

Run **S-8** with `<N> = 4`. Tag `v1.0.0`. Live run starts 5 December.
