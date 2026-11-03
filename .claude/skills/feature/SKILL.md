---
name: feature
description: Implement one backlog issue end to end in this repo — plan, branch, test-first, code, gates. Use whenever starting work on a GitHub issue or a backlog item.
---

# Implement a feature issue

1. **Trace.** Open the issue (`gh issue view <n>`). List the FR/NFR/ADR ids it names and read those sections in `docs/prd.md` and `docs/adr/`. If the issue names none, stop and ask Fahad to link one.
2. **Scope check.** Confirm the work is inside v1 (see CLAUDE.md "Do not build"). If not, stop.
3. **Plan.** Write ≤ 5 bullets: files to add/change, port or adapter touched, schema change (yes/no), tests to write. Wait for "go" when anything is ambiguous.
4. **Branch.** `git switch -c feat/<n>-<slug>` from an up-to-date `main`.
5. **Schema first.** If the plan changes tables, follow the `db-change` skill before any other code.
6. **Test first** for pure rules (scoring, policies, normalisers) and adapters (with recorded fixtures). Follow `testing-conventions`.
7. **Code.** Follow `hazeljs-conventions`. Smallest change that meets the acceptance criteria. No extra options, flags or abstractions "for later".
8. **Fake adapter + demo mode.** Any new external call needs a fake adapter and must work with `DEMO_MODE=true`.
9. **Gates.** `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`. Fix, don't suppress.
10. **Docs.** Update `docs/architecture.md`, `docs/database.md` or `.env.example` if behaviour, schema or config changed.
11. **Review.** Run the `reviewer` agent on the diff. Address findings.
12. **Ship.** Use the `ship` skill.
