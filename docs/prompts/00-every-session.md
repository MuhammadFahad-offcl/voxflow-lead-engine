# Prompts used in every cycle

Copy the text inside each block exactly. Replace `<...>` placeholders.

---

## S-1 — One-time: create milestones and issues from the backlog

Run once, before Cycle 1 issue 1.

```text
Read docs/backlog.md, docs/prd.md (Release plan) and .github/ISSUE_TEMPLATE/feature.md.

Using the gh CLI, in repo MuhammadFahad-offcl/voxflow-lead-engine:
1. Create 4 milestones with due dates:
   "Cycle 1 — Scored leads" due 2026-11-09,
   "Cycle 2 — Solutions and scripts" due 2026-11-16,
   "Cycle 3 — AI calls" due 2026-11-23,
   "Cycle 4 — Booking and operations" due 2026-11-30.
2. Create labels if missing: feature, chore, ci, spike, test, docs, experiment, release, bug.
3. Create one issue per backlog line, in backlog order, in the right milestone:
   - title = the backlog line's text up to the first " — " (keep the conventional prefix, e.g. "feat: campaigns API ...")
   - label = the prefix (feat → feature, chore, ci, spike, test, docs, experiment, release)
   - body = the feature template filled with: the FR/NFR/ADR ids from the line, a one-sentence user story,
     and 2–4 acceptance criteria taken from the matching FR text in docs/prd.md.
4. Print a table: issue number | title | milestone.
Show me the full list of issues you will create and wait for my "go" before creating anything.
```

After it runs, write the issue numbers next to each prompt id (C1-01 → #2, …). Branch names use the **GitHub issue number**.

---

## S-2 — Start of every Claude Code session

```text
New session. Before anything else:
1. Read CLAUDE.md, docs/engineering-standards.md and the "Fixed decisions" there. Do not read .env.
2. Run: git status, git branch --show-current, git log --oneline -5.
   If I am not on an up-to-date main with a clean tree, tell me and stop.
3. Tell me in 3 lines: current cycle (from today's date and docs/backlog.md), the last merged issue,
   and the next issue in order.
Then wait for the issue prompt.
```

---

## S-3 — Answering the plan

When the plan is right:

```text
Plan approved. Create the branch, write tests first where the issue has rules or adapters,
then implement. Stop and ask me if anything outside the plan becomes necessary.
```

When it is not:

```text
Change the plan: <what to change>. Keep everything else. Show the revised plan and wait.
```

---

## S-4 — When something fails

```text
<paste the error or describe the wrong behaviour>
Find the root cause before changing code. Explain it to me in 2–3 sentences, then:
write a failing test that reproduces it, fix the code, and re-run the full gates.
Do not weaken a test, lint rule or type to make it pass.
```

---

## S-5 — Review before shipping

```text
Run the reviewer agent on this branch (git diff main...HEAD).
Fix every blocker and should-fix it reports, re-run the gates, then show me:
the findings table, what you changed, and the final gate output.
Explain any decision in this PR that a junior developer might not understand, in plain words.
```

---

## S-6 — Ship

```text
Use the ship skill: verify gates, check the diff for secrets/real data/console.log,
commit with a conventional message that ends with "Closes #<issue>", push the branch,
and open the PR with .github/pull_request_template.md fully filled in.
Print the PR URL. Do not merge it — I review and merge on GitHub.
```

Then you: open the PR → **Files changed** → read it → **Squash and merge** → **Delete branch** →
`git switch main; git pull`.

---

## S-7 — Learn from the code (use any time)

```text
Explain <file or function> to me as a junior developer: what it does, why it is designed this way,
which FR/ADR it serves, and one thing that would break if we changed it. Do not edit anything.
```

---

## S-8 — Cycle close (Sunday)

```text
Cycle <N> is ending. Do the review and retro:
1. List the cycle's milestone issues with state (gh issue list --milestone "<milestone name>" --state all).
2. Run the full gates on main and report coverage for scoring/, policies/ and adapters/.
3. Run the app in DEMO_MODE=true and walk me through the cycle deliverable step by step so I can record a demo video.
4. Draft docs/retros/cycle-<N>.md from docs/retros/README.md with real numbers
   (planned vs done, CI failures, coverage). Leave "Went well / Went badly" for me to fill.
5. After I approve: open a docs PR with the retro, and after merge tag main as v0.<N>.0 with a short release note.
Do not move unfinished issues yourself — list them and ask me.
```

---

## S-9 — Scope guard (paste if Claude suggests extras)

```text
Stop. Check that against CLAUDE.md "Do not build" and the PRD. If it is not required by an FR/NFR
in this issue, remove it from the plan. If you think it is truly needed, write it as a one-paragraph
proposal for PRD → Future versions or a new ADR, and do not implement it.
```
