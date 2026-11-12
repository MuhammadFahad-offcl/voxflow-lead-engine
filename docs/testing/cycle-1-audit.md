# Cycle 1 break-it audit

Run 12 Nov 2026 on `main` at `65f97cf` (after #147 and #148), with prompt T-1 and N = 1. All tests used fake adapters and fictional data. No paid API was called.

Fixes are in three PRs. Merge them in this order:

| PR     | Branch                         | What it fixes                                                                                                                |
| ------ | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| A #152 | `chore/cycle-1-audit`          | Loopback-only `API_HOST`, one reviews run per campaign, `pnpm build` in CI, lead-runner tests, this report                   |
| B #153 | `chore/cycle-1-audit-security` | Links only for http(s), dashboard bound to 127.0.0.1, server API client kept out of the browser, 64 KiB body limit, log scan |
| C #154 | `chore/cycle-1-audit-p2`       | Non-UTF-8 pages, a clear exit when the port is taken, tests for untested failure paths                                       |

The three branches merge cleanly together. On the merged tree, typecheck, lint, knip, 960 tests and `pnpm build` all pass.

## 1. Inventory

295 tracked files, not counting `docs/`. 24,261 lines are in the apps and packages:

| Area                                            | Files |  Lines | Notes                                             |
| ----------------------------------------------- | ----: | -----: | ------------------------------------------------- |
| `apps/api`                                      |   160 | 21,362 | HazelJS API, worker, pipeline, adapters, tests    |
| `apps/web`                                      |    32 |  2,011 | Next.js dashboard, server-side calls only         |
| `packages/shared`                               |    15 |    888 | Zod schemas shared by api and web                 |
| `prisma`                                        |    11 |  1,208 | Schema and migrations                             |
| `config`                                        |     4 |    847 | Niche and catalog JSON                            |
| `fixtures`                                      |    23 |  1,001 | Fictional clinics, reviews and LLM answers        |
| `scripts`                                       |     4 |    780 | One-off #9 spike scripts, never run in production |
| Root, `.github`, `.claude`, `.husky`, `.vscode` |    46 |  1,329 | Configuration, CI, agent and editor settings      |

These source files have no test of their own:

- **Entry points:** `main.ts`, `worker.ts`, `read-website.ts`, `llm-record.ts`. The integration tests and the build cover the code they call.
- **Server-rendered pages and Server Actions in `apps/web/app`.** The `lib/` functions they call are tested.
- **Type-only modules in `packages/shared`.** They are covered through the tests that parse with them.

## 2. Coverage, before → after

Jest with `--coverage`, all three projects, on `main` and then on the three PRs merged together.

|        | Statements | Branches |  Lines | Tests |
| ------ | ---------: | -------: | -----: | ----: |
| Before |     97.00% |   89.80% | 97.65% |   919 |
| After  |     97.98% |   90.18% | 98.60% |   960 |

Files that changed most (lines / branches):

| File                         | Before        | After         |
| ---------------------------- | ------------- | ------------- |
| `scheduler/lead-runner.ts`   | 66.7% / 64.3% | 95.4% / 76.7% |
| `pipeline/lead.graph.ts`     | 95.3% / 86.8% | 100% / 89.5%  |
| `db/lead-run.repository.ts`  | 100% / 70.0%  | 100% / 75.0%  |
| `bootstrap.ts`               | 68.8% / 0%    | 70.6% / 0%    |
| `port-check.ts` (new)        | —             | 91.7% / 50.0% |
| `web/lib/safe-href.ts` (new) | —             | 100% / 100%   |

`bootstrap.ts` stays low on purpose. Its untested branch builds the real adapters when `DEMO_MODE=false`, and tests never build real adapters.

## 3. Attacks

The attack plan had 33 attacks. For each one we wrote a test or ran a check:

| Group                    | Tried                                                                                                                                                                                                   | Result                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Security and binding     | API on `0.0.0.0`; check the real socket address; `javascript:` and `data:` evidence links; `next start` on every interface; server code reaching the browser; full phone numbers or review text in logs | 4 bugs, fixed. The log scan was clean.                                     |
| Restarts and concurrency | Two workers on one campaign's reviews; a pass that throws; `stop()` during a pass; Postgres down mid-pass                                                                                               | 1 bug, fixed. The loop already survived a failed pass; that is now tested. |
| Lead graph endings       | HazelJS timeout between nodes; checkpoint save fails after a paid step; lost claim; spend cap                                                                                                           | Correct; the first two are now tested                                      |
| Outside services         | Apify invalid items; Anthropic 529, a cut-off answer, a refusal; Perplexity 429 and empty results                                                                                                       | Correct; already tested                                                    |
| Inputs                   | Body `{`, wrong content type, a 70 KB body; Urdu and Eastern Arabic digits; `+92 (0)300`; `0092`; Unicode domains; 30 long Urdu reviews; `windows-1256` pages                                           | 1 bug, fixed (page decoding)                                               |
| Time                     | Karachi day and month edges for the caps and the costs page                                                                                                                                             | Correct; already tested                                                    |
| Build and run            | Fresh clone with `pnpm install --frozen-lockfile` and `pnpm build`; `pnpm audit --prod`; port 4000 taken                                                                                                | Clone and build pass. 1 bug, fixed (taken port). 2 advisories (#151).      |

## 4. Bugs found

| #   | Pri | Bug                                                                                                                                    | How it showed                                                 | Fix                                                                  |
| --- | --- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------- |
| 1   | P1  | `API_HOST` accepted any value, so `0.0.0.0` exposed the API to the LAN (ADR-0003)                                                      | `env.spec.ts`                                                 | PR A: only `127.0.0.1` or `localhost`                                |
| 2   | P1  | Two workers could both start the reviews step for one campaign. The second saw a run with no id and **paused the campaign by mistake** | `lead-runner.int.spec.ts`, two workers; fails on the old code | PR A: claim the campaign (`discoveryClaimedAt`) for the step         |
| 3   | P1  | CI never ran `pnpm build`, so a broken production build could merge                                                                    | Review of `ci.yml`                                            | PR A: build step after knip                                          |
| 4   | P2  | Evidence links rendered any URL as `<a href>`, including `javascript:` from a scraped site                                             | `lead-evidence.spec.ts`                                       | PR B: `safeHref`, links for http(s) only; other sources show as text |
| 5   | P2  | The dashboard had no `start` script, and `next start` listens on every interface                                                       | Review of `apps/web/package.json`                             | PR B: `--hostname 127.0.0.1` for dev and start                       |
| 6   | P2  | The browser bundle included the server-side API client: a client form imported `ApiRefusal` from `lib/api.ts`                          | `boundaries.spec.ts`; fails on the old code                   | PR B: `ApiRefusal` in its own file                                   |
| 7   | P2  | Pages were always decoded as UTF-8, so a `windows-1256` Urdu site was read as `����` and scored on noise                               | `safe-get.spec.ts`                                            | PR C: charset from the header or `<meta>`, else UTF-8                |
| 8   | P2  | A taken port 4000 crashed the API with an uncaught EADDRINUSE stack trace                                                              | Manual run, then `port-check.spec.ts`                         | PR C: check the port first and exit with one clear line              |
| 9   | P3  | `pnpm seed:perf` was missing from the README Scripts table                                                                             | Review                                                        | PR A                                                                 |

Also hardened, though not a bug: the API body limit went from HazelJS's 1 MiB default to 64 KiB. A malformed body already got a 400, and that is now tested. `/webhooks/vapi` will need a larger limit for end-of-call reports; that is noted on #28.

Two gaps were not fixed here:

- Website phone extraction was promised for Cycle 1 (FR-6) but not built. It is #150, in Cycle 2.
- Two high transitive advisories need upstream releases: #151.

## 5. Risks left

| Risk                                                                                                                                            | Why it stays                                                                           | Mitigation                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| A spend cap can be passed by the calls in flight at the same moment, up to 3 × the worst case (about $0.015 for Perplexity, $0.003 for the LLM) | Documented trade-off from #12 (`llm.service.ts`). A strict fix needs reservation rows. | Cap is checked before every call; the overshoot is bounded and small                  |
| A failed checkpoint save marks the lead FAILED, though its step's work is stored                                                                | Same handling as any database error in a step (FR-32)                                  | Retry button on the dashboard; the retry skips the stored work and pays nothing twice |
| Another process can take port 4000 between the check and `listen`                                                                               | The check cannot hold the port for HazelJS                                             | Rare. It falls back to the old uncaught error.                                        |
| `basic-ftp` and zod 3 advisories (#151)                                                                                                         | Need apify-client and HazelJS releases                                                 | Not reachable in v1: no FTP proxy; our own validation uses zod 4.6.7                  |
| Server Actions and DNS rebinding                                                                                                                | Next.js checks Origin against Host, but rebinding is a known gap                       | Dashboard bound to 127.0.0.1; one user. Revisit before any deployment.                |
| Urdu business names (ہسپتال) skip the hospital and chain filter                                                                                 | Keywords are English only (P3)                                                         | Lahore listings are mostly in English; a Cycle 2 candidate                            |
| `knip` sometimes runs out of memory on this laptop                                                                                              | oxc-parser needs one block over 1 GiB (#125)                                           | CI's knip passes; re-run locally                                                      |
| A worker killed between the Apify start and saving its run id (`campaign-runner.ts`, 71% branches)                                              | Partly covered                                                                         | The campaign pauses for a check and never pays twice (ADR-0015)                       |

## 6. The 5 files to read first

1. **`apps/api/src/scheduler/lead-runner.ts`**: the worker loop. Claims, leases, the reviews step, and how shutdown waits for a paid start. Most of the concurrency bugs lived here.
2. **`apps/api/src/pipeline/lead.graph.ts`**: one HazelJS AgentGraph run per lead. It has five endings (completed, failed, paused, stopped, claim lost); learn what each does to the lead and its run.
3. **`apps/api/src/llm/llm.service.ts`**: every LLM call goes through this gate. It checks the worst-case cost against the monthly cap, records the cost, and validates the answer.
4. **`apps/api/src/adapters/web-reader/safe-get.ts`**: the only code that downloads untrusted pages. It checks addresses, redirects, size and time limits, and now the charset.
5. **`apps/web/lib/api.ts`**: the dashboard's only path to the API. It runs on the server only; `boundaries.spec.ts` keeps it out of the browser.
