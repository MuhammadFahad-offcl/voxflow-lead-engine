# Cycle 1 retro — 3 to 12 Nov 2026

Cycle 1, "Scored leads", was planned to end on 9 Nov. It moved to 13 Nov (PRD 0.5, "Cycle 1 slipped 4 days") and finished on 12 Nov.

## Delivered

- **Planned issues closed: 14 of 14** (#3–#16):
  - scaffold, CI, Docker and Prisma, env and DI, seed, campaigns API;
  - Apify spike;
  - discover;
  - website reading;
  - reviews and web context;
  - LLM labelling;
  - scoring;
  - lead `AgentGraph`;
  - dashboard.
- **Unplanned issues added: 4.** #45, #47 and #64 are closed. #125 (flaky DB suites / knip crash after an install) is still open and **moved to Cycle 2**.
- **The deliverable**, in `DEMO_MODE=true` with every outside service faked:
  - create "dental-clinic / Lahore / DHA, Gulberg";
  - discovery, website reading, web context, reviews, LLM labelling and scoring run per lead in a HazelJS `AgentGraph`;
  - the lead table filters, sorts and expands each lead to its evidence;
  - the CSV holds exactly the filtered rows.
- **Tag:** `v0.1.0`, after the founder's approval. **Demo video:** _(link to add)_

## Went well

- _(founder)_

## Went badly

- _(founder)_

## Change next cycle (max 3, each an action)

- _(founder)_

## Metrics

| Measure                                       | Cycle 1                                                                                                                                                               |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Planned vs done issues                        | 14 planned, 14 done; 4 unplanned added (3 done; #125 moved to Cycle 2)                                                                                                |
| Pull requests merged                          | 106 (3–12 Nov), about 10 per day                                                                                                                                      |
| PR size                                       | median 318 changed lines; 33 of 106 over 400. These counts include lockfiles and generated code, so they are upper bounds.                                            |
| Commits on main                               | 96: stacked PRs merged into their parent's branch, not main                                                                                                           |
| CI failures on main                           | **1**, on 11 Nov: GitHub's artifact upload failed in the gitleaks step, not the code. 14 runs were cancelled because a newer push replaced them.                      |
| Tests                                         | 919 in 72 suites (api, web, shared), all passing                                                                                                                      |
| Coverage, all files                           | statements 97.0%, branches 89.8%, functions 97.0%, lines 97.7%                                                                                                        |
| Coverage, `scoring/`                          | statements 99.2%, branches 95.6%, functions 100%, lines 100% (gate: 80%)                                                                                              |
| Coverage, `adapters/` (statements / branches) | lead-source 97.0 / 81.3%, llm 97.3 / 84.2%, web-context 100 / 96.7%, web-reader 97.7 / 92.2%                                                                          |
| Coverage, `policies/`                         | none yet: policies come with calling, Cycle 3                                                                                                                         |
| NFR-3 (pages under 2 s with 5,000 leads)      | campaign page warm median 689 ms; filtered page 597 ms; CSV of 5,000 rows 174 ms (`pnpm seed:perf`, `pnpm dev`)                                                       |
| Demo run (DHA + Gulberg)                      | 8 searches, 16 found, 1 duplicate (6%), 2 filtered out, 13 qualified: 6 WARM, 7 COLD, 0 HOT; SCORING at 62 s                                                          |
| Real-service spend                            | about **$1.382 of the $5 cycle budget**: Apify spike $0.66 (#9), Apify DHA run $0.7208 (#10), Claude labelling recording $0.00204 (#13). No other real call was made. |

## Facts for the discussion

These are facts from the cycle's issues and PRs, to help fill the sections above:

- **#10 took 27 PRs and #11 took 10**, before the rule of 1–4 PRs per issue (9 Nov). Several later PRs went over 400 lines and said so in their description: #137 (about 800), #138 (about 720), #143 (645) and #147 (917).
- **Stacked PRs and squash merges**: twice a child PR merged before its parent, so it landed on the parent's branch. #117–#119 reached main through #116, and #146 through #145. No work was lost.
- **The `reviewer` agent's should-fix findings changed behaviour in nearly every #15 and #16 PR.** Examples: the claim renewal before each graph node, the reviews pass never paying twice, the `%`/`_` area wildcard, the CSV formula prefix and BOM, the duplicate-campaign guard on the form, and a select that reset after a submit.
- **The p08 decision** (`reviews_unreplied` needs 10 stored reviews) removed the demo's HOT leads. The demo now shows WARM leads at most.
- **Local tooling:** knip's parser crashes now and then on this laptop when it cannot reserve a block of over 1 GiB (#125). CI is not affected.
- **The break-it audit (T-1, N = 1, 12 Nov)** tried 33 attacks with fake adapters only. It found 9 bugs: 3 P1, 5 P2, 1 P3 (`docs/testing/cycle-1-audit.md`).
  - The P1s: `API_HOST` accepted `0.0.0.0`; two workers could both start one campaign's reviews step, and the second paused the campaign by mistake; CI never ran `pnpm build`.
  - The fixes are in #152, #153 and #154 (merge in that order). With them, coverage is statements 97.98%, branches 90.18%, lines 98.60%, with 960 tests.
  - Not fixed in the audit: website phone extraction (FR-6), promised for Cycle 1 but not built, is #150 in Cycle 2. Two high transitive advisories (`basic-ftp` through apify-client, zod 3 through @hazeljs/agent) need upstream releases: #151, Cycle 2.
