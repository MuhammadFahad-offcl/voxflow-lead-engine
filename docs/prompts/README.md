# Claude Code prompts — how to use them

These files hold one ready-to-paste prompt per backlog issue, cycle by cycle. They turn `docs/backlog.md` into instructions Claude Code can execute without guessing.

| File | Cycle | Dates | Deliverable |
|---|---|---|---|
| [`00-every-session.md`](00-every-session.md) | all | — | Session start, plan review, fix, review, ship, cycle close |
| [`cycle-1-scored-leads.md`](cycle-1-scored-leads.md) | 1 | 3–9 Nov | Lead table of enriched, scored leads with evidence + CSV |
| [`cycle-2-solutions-scripts.md`](cycle-2-solutions-scripts.md) | 2 | 10–16 Nov | One service + Urdu script per warm/hot lead, campaign approval |
| [`cycle-3-ai-calls.md`](cycle-3-ai-calls.md) | 3 | 17–23 Nov | Policy-gated Urdu AI calls with logged outcomes; HazelJS submission |
| [`cycle-4-booking-ops.md`](cycle-4-booking-ops.md) | 4 | 24–30 Nov | Booking during the call, operations, v1.0 |

## Can Claude Code write the files itself?

Yes. Claude Code in VS Code creates folders, writes and edits files, runs `pnpm`, tests and Git commands **in your project folder**. You do not copy code by hand. What you do:

1. Paste a prompt.
2. Read its plan and answer its questions (this is where you learn — ask "why?" freely).
3. Approve file edits and commands when VS Code asks (or allow them for the session).
4. Read the diff before you approve the commit.

It also works the other way: you can ask Claude Code to **update docs from the code** ("read `apps/api/src/scoring` and update `docs/architecture.md` §5 to match"). The rule stays: docs and code must agree in the same PR.

## The loop for every issue (≈ 1–3 hours each)

```
0. One-time: create the GitHub issues  → prompt S-1 in 00-every-session.md
1. New Claude Code chat                 → prompt S-2 (session start)
2. Paste the issue prompt               → e.g. C1-01 from cycle-1
3. Claude shows a plan                  → you reply "go" or correct it (S-3)
4. Claude codes + tests + runs gates
5. Review                               → prompt S-5 (reviewer agent)
6. Ship                                 → prompt S-6 (commit, push, PR)
7. You: read "Files changed" on GitHub → Squash and merge → git switch main; git pull
```

## Rules that keep quality high

- **One issue per chat.** Start a fresh chat for each issue (`/clear`). Long chats drift and forget rules.
- **Never skip the plan step.** If the plan touches files the issue doesn't need, say no.
- **Gates are not optional.** `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` must be green before S-6.
- **Do issues in order.** Later prompts assume earlier ones are merged.
- **If reality differs from a prompt** (a library API changed, a price changed), Claude must stop and propose an ADR — not silently change the design.
- **`[YOU]` steps** in a prompt are things only you can do (create an account, paste a key into `.env`, make a test call). Claude will pause for them.
- Before a prompt that needs real keys, put them in `.env` yourself. Claude is not allowed to read `.env`.
