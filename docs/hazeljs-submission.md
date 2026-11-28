# HazelJS ambassador submission

- **Submit at:** https://hazeljs.ai/build#submit with the public GitHub repo link.
- **Submission date:** 29 Nov 2026. What is on `main` then is the submission; everything else is roadmap. The tag for that state is `v0.2.0`, set by the founder after this pass merges. The script and approval agents (#20, #23) are in the `v0.3.0` milestone.
- **Challenge field:** Other / custom project.

## How the project maps to the evaluation criteria

| Criterion                                  | Weight | Where it is shown                                                                                                                                                                                                                                                    |
| ------------------------------------------ | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Practical use of HazelJS                   | 30%    | `AgentGraph` per lead with the SQL durable run store; the solution `@Agent` with its `@Tool`; a custom `LLMProvider` behind the spend cap; `@hazeljs/testing` agent tests. README lists each with file links. Two upstream issues filed and fixed, three more found. |
| Functionality and technical implementation | 25%    | Demo mode runs a campaign offline from discover to solution: enrich, evidence-based score, one catalog service (or `NO_STRONG_SIGNAL` / `NEEDS_REVIEW`) per warm or hot lead, shown on a lead page. No call or booking yet. Fresh clone measured on 28 Nov 2026.     |
| Creativity and innovation                  | 20%    | Evidence-based scoring from public reviews: the LLM labels, plain code scores, no evidence means no points; the solution agent must cite the lead's own signals, or pick nothing. Urdu AI calls are on the roadmap.                                                  |
| Code quality and documentation             | 15%    | Strict TypeScript, CI gates (typecheck, lint, Knip, 1,062 tests, gitleaks), ADRs, PRD, architecture doc, development log in `docs/retros/`                                                                                                                           |
| Real-world impact                          | 10%    | Built for VoxFlow AI Solutions' own outreach; not yet used in production. No clients, calls or results are claimed.                                                                                                                                                  |

Planned and not claimed: the script agent (#20), durable HITL campaign approval (#23), Gatekeeper call policies (#26), the run timeline (#30), Urdu calls (#27, #28) and booking (#33). See README → Roadmap and Contributions to HazelJS.

## The email's tips, and how we cover them

- Functional over complicated → one niche, one city, demo mode.
- Show HazelJS AI capabilities → section 16 of `docs/architecture.md`.
- Easy to understand and run → README quick start, measured on a fresh clone: about 2½ minutes with Docker images and packages cached.
- Document the development process → sprint retros in `docs/retros/`.
- Explain technical decisions → ADRs in `docs/adr/`.
- Understand the code you submit, even with AI help → every merged line is reviewed by the founder.

## Repository checklist before submitting

- [x] Public repo, complete source, MIT licence (`LICENSE`)
- [x] README: purpose, pipeline diagram, setup, HazelJS packages and features used with file links
- [x] Fresh clone runs demo mode in ≤ 10 minutes (Windows, 28 Nov 2026; on this machine, not yet on another one)
- [ ] Screenshots: campaign list, lead table, lead page
- [ ] 2–3 minute demo video (outline below)
- [ ] gitleaks: CI scans every pull request's commits; a full-history scan has not been run
- [ ] Only packages and capabilities that actually run are ticked on the form

## Submission description (150 words)

> VoxFlow Lead Engine finds local businesses and decides, with evidence, which ones need AI automation. A HazelJS `AgentGraph` runs once per lead, recorded in Postgres through HazelJS's SQL run store: it reads the clinic's website, gathers web context, has Claude label public reviews, then scores the lead from 0 to 100 in plain code. No evidence, no points. For warm and hot leads, a HazelJS `@Agent` with one `@Tool` searches a pgvector service catalog and must pick one service that cites the lead's own signals, or pick nothing. Every model call passes through a custom `LLMProvider` that enforces a monthly spend cap. A Next.js dashboard creates campaigns and shows each lead's score breakdown, chosen service and reviews. Demo mode runs the whole pipeline offline on fictional Lahore dental clinics with recorded model answers, and 1,062 tests run in CI. Urdu AI calls and meeting booking are on the roadmap.

## Demo video outline (3 minutes, demo mode only)

| Time      | Screen                                                     | Say                                                                                                                                             |
| --------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| 0:00–0:20 | README top and the pipeline diagram                        | The problem; what is built (discover → enrich → score → solution) and what is roadmap.                                                          |
| 0:20–0:45 | README → HazelJS features used, `lead.graph.ts`            | One `AgentGraph` per lead, the SQL run store, the solution `@Agent` and its `@Tool`, the gated `LLMProvider`.                                   |
| 0:45–1:10 | Dashboard: New campaign, Lahore, DHA chip, Create          | Demo mode: fake Apify, website reader, Perplexity and recorded Claude answers. The page fills in seconds: 11 leads, 6 WARM.                     |
| 1:10–1:45 | Lead page for p01, Fictional Bright Smile Dental           | Score 67 from evidence lines; the pick "Missed-call WhatsApp reply" with the two signals it cites highlighted; the reviews behind them.         |
| 1:45–2:10 | Lead page for p03, Fictional DHA Family Dentistry          | WARM (47) but no pain signal, so `NO_STRONG_SIGNAL`: the agent picks nothing rather than invent a reason.                                       |
| 2:10–2:35 | `GET /costs/status`, `CostRecord` rows in `pnpm db:studio` | Every call is recorded (fake costs in demo mode); the LLM gate refuses a call that could pass the cap; the cap banner shows once it is reached. |
| 2:35–3:00 | `solution.agent.spec.ts`, `spend-cap.spec.ts`, CI run      | `@hazeljs/testing` runs the real runtime against scripted answers; the cap tests; CI green. Close on the roadmap and the upstream issues.       |

Show only demo mode. Do not show or mention calls, clients or results.
