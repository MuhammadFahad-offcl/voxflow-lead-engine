---
name: ship
description: Commit, push and open a pull request the way this repo requires. Use when the work for an issue is done and the gates are green.
---

# Ship an issue

1. `git status` and `git diff --stat`. Changed lines ≤ 400; if more, propose how to split.
2. Confirm gates passed in this session: `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`.
3. Check the diff has no secrets, no real phone numbers, no `.only`, no `console.log`, no commented-out code.
4. Commit with Conventional Commits, scope = module: `feat(scoring): add review-based pain signals (FR-14)`. Body: what and why in 1–3 lines, then `Closes #<n>`.
5. `git push -u origin <branch>` (ask first).
6. `gh pr create` with `.github/pull_request_template.md` filled: summary, FR/NFR/ADR ids, how tested, screenshots for UI, risks.
7. After CI is green: squash merge, delete branch, move the issue to Done.
