# Cycle 1 handoff (written 5 Nov 2026)

For the next Claude Code session (cloud) and Fahad. It is the state of the Cycle 1 run, so the work can continue without the earlier chat. Delete this branch once Cycle 1 closes.

## First: check where #10 is

A laptop script was shipping #10 when this was written. **Never ship from two places at once.**

```bash
gh issue view 10 --json state --jq .state
gh pr list --state open
git fetch origin && git log --oneline origin/main -3
```

- **#10 is CLOSED:** go to "What is left".
- **#10 is OPEN:** ask Fahad whether the laptop script is still running. If it is, wait. If it stopped, finish it with "Finishing #10".

## Done so far

| Item | State |
| --- | --- |
| #3 to #9, #45, #47 | Merged and closed |
| Comment standard | Merged (#43); reviewer checklist item 8 covers what lint cannot |
| `ci` required on `main` | Yes, `enforce_admins` on. CI also runs `prettier --check` and a PR-title commitlint |
| #10 | Fully built, reviewed 3 times, proven by a real Apify run; shipping as 27 ordered PRs |

### #10 real Apify run

DHA, 4 searches at 30 results: reached ENRICHING with no warnings. 119 found, 30 duplicates, 33 filtered, 56 qualified. Charged **$0.7208** (4 x $0.1802), recorded in `CostRecord`.

### Spend

| Item | USD |
| --- | --- |
| #9 spike | 0.66 |
| #10 real run | 0.7208 |
| **Total** | **1.3808** |
| **Left of the $5 Cycle 1 limit** | **3.6192** |

The dev database's `apifyDailyUsd` is back at 2.00.

## Finishing #10, if the laptop script stopped

All branches are on `origin`. Reviewed code is the top branch `feat/10-discover` at 1392cfb, plus any merge-from-main commits. The order is:

`1-normalize, 2-filter, 2b-filter-rules, 3-schema, 4-areas, 5-osm-polygons, 6-port-fake, 7-compass-rules, 8-apify-adapter, 9-rules, 10-repo-claims, 11-repo-store, 12-step, 13-step-safety, 14-runner, 15-reserve-repo, 16-reserve-step, 17-reserve-tests, 18-run-problems, 19-error-pause, 20-worker-shutdown, 21-reopen, 22-draft-areas, 23-store-guards, 24-cap-and-start, 25-filter-and-phone`, then `feat/10-discover`. Each is `feat/10-discover-<name>`, except the last.

For each slice not yet merged (skip any with `gh pr list --head <branch> --state merged`):

1. `git fetch origin main`, then `git switch <branch>`.
2. If `origin/main` is not already an ancestor of the branch: check `git diff --quiet origin/main <branch>^`, then `git merge -s ours --no-edit origin/main`. A plain merge gives add/add conflicts, because squash merges rewrite history. **The check matters:** `-s ours` is only safe if `main` equals the previous slice. If the check fails, stop and tell Fahad.
3. `git push -u origin <branch>`. Never force-push.
4. Open the PR with the commit subject as title, the PR template filled, `Refs #10`. Only the last PR says `Closes #10`.
5. `gh pr checks <n> --watch`, then `gh pr merge <n> --squash --delete-branch`. A 502 from GitHub can still mean it merged, so check the state before retrying.

**Do not merge anything else to `main` until #10 finishes**, or step 2's check fails.

When done, confirm `git diff 1392cfb origin/main` is empty, and that the CI run on `main` is green. Local-only backups `backup/10-before-*` can then go.

## What is left

In order, one fresh subagent each, using `docs/prompts/cycle-1-scored-leads.md`:

1. **After #10:** a small chore PR adding read-only `Bash(gh pr checks *)` and `Bash(pnpm knip *)` to `.claude/settings.json`. Nothing else: never allow push, merge, delete, rm, curl or broad network there. Fahad's own approvals live in the git-ignored `.claude/settings.local.json`.
2. **#11** WebReaderPort.
3. **#12** reviews storage and WebContextPort. Stop and ask: Perplexity key.
4. **#13** LlmPort. Stop and ask: Anthropic key. **Checkpoint after #13:** summary, then wait for "continue".
5. **#14** scoring. **#15** lead AgentGraph. **#16** dashboard.
6. **After #16:** S-8 cycle close, but do not tag until Fahad approves. Give Fahad a table of every Cycle 1 file (path, lines, what it does) and the order to read them. Then stop.

Per issue: subagent builds, `reviewer` agent, a subagent fixes every blocker and should-fix, gates, ship with "Closes #n", wait for CI, squash-merge, then 3 lines in chat (done, PR link, next).

## Notes the prompts do not have

- **#11:** `normalizeUrl` only rejects example local hosts. #11 must check the resolved address before fetching.
- **#12:** owns ADR-0015 pass 2, Scraperlink's 30 newest reviews by place id. `fixtures/reviews` has no Gulberg rows, so add them. Real items can hold nulls that fakes never show (a real `reviewsCount: null` appeared in #10).
- **#14:** `no_online_booking` reads Compass `bookingLinks` from `rawPlace`. The founder's full rule is in the comments on issue #14. The PRD scoring model is authoritative.
- **#15:** `@hazeljs/agent` 2.0.13 fails on root import without `@hazeljs/eval`. Ask Fahad to approve `@hazeljs/eval` 2.0.13 first. `apps/api/test/db.int.spec.ts` deep-imports the store as a workaround; replace it then.
- **HazelJS 2.0.13 swallows startup errors:** keep any check that must stop startup out of `onModuleInit` and synchronous factories. Env is parsed before HazelJS starts (ADR-0014). Nothing is filed upstream; Fahad files those personally, Claude only drafts.
- **Tests:** `createTestDatabase(name)` needs a unique name per spec. Tests must force `DEMO_MODE=true` and no real keys.
- **Known, accepted #10 limits:** a stale worker can store a failed run in a small window just after a new worker claims, leaving only a warning in the log. On an operator pause the same failed-run pause can appear twice before resume moves on; nothing is paid twice. Paying for a failed search again needs a new campaign.
- **Not proven on real data:** closed-place filtering (no closed place appeared; unit tests only), and the Model Town, Bahria Town, Johar Town and Gulberg polygons on Compass. Only the DHA box has run.

## Fahad's standing rules

**Stop and ask, never guess:** an issue needing Fahad's keys or accounts; anything that changes the PRD, an ADR, the schema, or scope beyond the prompt; any new dependency; **any real-money run**.

**Real money:** ask before every real run. Each test under $1, the whole cycle under $5. Show the maximum cost first.

**Never:** skip or weaken gates or tests, push to `main`, force-push, read any `.env` file (not even a `grep`), make phone calls, or build outside v1 (CLAUDE.md "Do not build"). The same CI failure twice means stop and tell Fahad.

**Comments and PRs:** the comment standard in `docs/engineering-standards.md` §1 applies. PRs stay at 400 changed lines or fewer, excluding lockfiles and migrations.

**Fahad is a junior developer learning from this work.** Explain decisions plainly.

## What a cloud session does not have

Only what is on GitHub. These stay on Fahad's laptop:

- `.env` and all API keys, so real runs (Apify, Perplexity, Anthropic) must happen on the laptop or with keys Fahad sets up
- The dev database (Postgres in Docker), holding real test leads
- `.claude/settings.local.json` and Claude's local memory notes
- The ship script and logs in the old session's scratchpad

Integration tests need Postgres; the cloud environment may need its own, using the compose image `pgvector/pgvector:pg17`.
