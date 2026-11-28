# HazelJS ambassador submission

- **Submit at:** https://hazeljs.ai/build#submit with the public GitHub repo link.
- **Target date:** not set. The old plan was 27 Nov 2026, at the end of Cycle 3 with tag `v0.3.0`; that date has passed with Cycle 2 still open, and `v0.3.0` does not exist. The HazelJS email sets no separate deadline; the Q4 build challenge closes 31 Dec 2026.
- **Challenge field:** Other / custom project.

## How the project maps to the evaluation criteria

| Criterion                                  | Weight | Where it is shown                                                                                                                                                                                             |
| ------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Practical use of HazelJS                   | 30%    | `AgentGraph` per lead with the SQL durable run store; the solution `@Agent` with its `@Tool`; a custom `LLMProvider` behind the spend cap; `@hazeljs/testing` agent tests. README lists each with file links. |
| Functionality and technical implementation | 25%    | Demo mode runs a campaign offline from discover to solution: enrich, evidence-based score, one catalog service per warm or hot lead. No call or booking yet. Fresh-clone test still to do (#32).              |
| Creativity and innovation                  | 20%    | Evidence-based scoring from public reviews: the LLM labels, plain code scores, no evidence means no points; the solution agent must cite the lead's own signals. Urdu AI calls are on the roadmap.            |
| Code quality and documentation             | 15%    | Strict TypeScript, CI gates, ADRs, PRD, architecture doc, development log in `docs/retros/`                                                                                                                   |
| Real-world impact                          | 10%    | Built for VoxFlow AI Solutions' own outreach; not yet used in production. Honest metrics only — no claimed clients until they exist                                                                           |

Planned and not claimed until built: durable HITL campaign approval (#23), Gatekeeper call policies (#26), the run timeline (#30), Urdu calls (#27, #28) and booking (#33). See README → Roadmap and Contributions to HazelJS.

## The email's tips, and how we cover them

- Functional over complicated → one niche, one city, demo mode.
- Show HazelJS AI capabilities → section 16 of `docs/architecture.md`.
- Easy to understand and run → README quick start; the fresh-clone timing is still to measure (#32).
- Document the development process → sprint retros in `docs/retros/`.
- Explain technical decisions → ADRs in `docs/adr/`.
- Understand the code you submit, even with AI help → every merged line is reviewed by the founder.

## Repository checklist before submitting

- [ ] Public repo, complete source, MIT or Apache-2.0 licence
- [ ] README: purpose, architecture diagram, setup, HazelJS packages and features used with file links
- [ ] Fresh clone on another machine runs demo mode in ≤ 10 minutes
- [ ] Screenshots: campaign list and lead table now; lead detail, approval screen and call result once they exist
- [ ] 2–3 minute demo video
- [ ] gitleaks clean across history; no real lead data
- [ ] Only packages and capabilities that actually run are ticked on the form
