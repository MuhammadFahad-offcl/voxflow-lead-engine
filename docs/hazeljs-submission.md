# HazelJS ambassador submission

- **Submit at:** https://hazeljs.ai/build#submit with the public GitHub repo link.
- **Target date:** 23 Nov 2026 (end of Cycle 3, tag `v0.3.0`). The HazelJS email sets no separate deadline; the Q4 build challenge closes 31 Dec 2026.
- **Challenge field:** Other / custom project.

## How the project maps to the evaluation criteria

| Criterion | Weight | Where it is shown |
| --- | --- | --- |
| Practical use of HazelJS | 30% | `AgentGraph` per lead; `@Agent`/`@Tool` agents; durable HITL campaign approval with SQL run store; Gatekeeper policies before every call; run timeline; `@hazeljs/testing` agent tests. README lists each with file links. |
| Functionality and technical implementation | 25% | Demo mode runs one campaign end to end from a fresh clone, including a simulated call |
| Creativity and innovation | 20% | Evidence-based scoring from public reviews; Urdu AI calls that book meetings live |
| Code quality and documentation | 15% | Strict TypeScript, CI gates, ADRs, PRD, architecture doc, development log in `docs/retros/` |
| Real-world impact | 10% | Built for and used by a real agency; honest metrics only — no claimed clients until they exist |

## The email's tips, and how we cover them

- Functional over complicated → one niche, one city, demo mode.
- Show HazelJS AI capabilities → section 16 of `docs/architecture.md`.
- Easy to understand and run → README quick start in ≤ 10 minutes.
- Document the development process → sprint retros in `docs/retros/`.
- Explain technical decisions → ADRs in `docs/adr/`.
- Understand the code you submit, even with AI help → every merged line is reviewed by the founder.

## Repository checklist before submitting

- [ ] Public repo, complete source, MIT or Apache-2.0 licence
- [ ] README: purpose, architecture diagram, setup, HazelJS packages and features used with file links
- [ ] Fresh clone on another machine runs demo mode in ≤ 10 minutes
- [ ] Screenshots: lead table, lead detail with evidence, approval screen, call result with remarks
- [ ] 2–3 minute demo video
- [ ] gitleaks clean across history; no real lead data
- [ ] Only packages and capabilities that actually run are ticked on the form
