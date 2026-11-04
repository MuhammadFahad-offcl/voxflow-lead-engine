# Contributing

This repo is run like a small product team, even with one developer. The full rules are in [`docs/engineering-standards.md`](docs/engineering-standards.md); this page is the short version.

## Scrum rhythm (one-week cycles)

| Day    | Ceremony      | Output                                                                                  |
| ------ | ------------- | --------------------------------------------------------------------------------------- |
| Monday | Planning      | issues for the cycle moved to "In progress" column, cycle goal written in the milestone |
| Daily  | Stand-up note | 3 lines in the cycle milestone: done / next / blocked                                   |
| Sunday | Review        | demo of the cycle deliverable (screen recording), tag `v0.N.0`                          |
| Sunday | Retro         | `docs/retros/cycle-N.md`                                                                |

## From issue to merge

1. Pick an issue from the current milestone. It must name an FR/NFR or ADR.
2. Branch from `main`: `feat/12-apify-adapter`.
3. Commit with Conventional Commits: `feat(discover): normalise Pakistani phone numbers`. `pnpm install` sets up the Git hooks that check the message and format and lint staged files.
4. Run `pnpm typecheck && pnpm lint && pnpm knip && pnpm test`.
5. Open a PR with the template. Keep it under 400 changed lines.
6. CI green + self-review with the checklist (or the `reviewer` agent) → squash merge → delete branch.

## Change control

The PRD scope is frozen for v1. To change anything decided:

1. **Requirement change** → PR to `docs/prd.md` with a changelog row and version bump.
2. **Technical decision change** → new ADR that supersedes the old one (`docs/adr/template.md`).
3. **New idea** → add it to PRD → Future versions. It is not built in v1.

Code PRs that don't trace to a requirement or ADR are closed.

## Definition of done

- [ ] Acceptance criteria of the FR met and demonstrated
- [ ] Tests added; coverage gates pass
- [ ] Typecheck, lint, Knip, gitleaks green
- [ ] Works in `DEMO_MODE=true`
- [ ] Docs updated if behaviour, config or schema changed
- [ ] No secrets, real lead data or recordings committed
