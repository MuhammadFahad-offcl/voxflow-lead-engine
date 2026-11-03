# Engineering standards

These rules apply to every line of code, whether written by a person or by Claude Code. CI enforces what it can; review enforces the rest.

## 1. Code

- TypeScript `strict` plus `noUncheckedIndexedAccess`, `noUnusedLocals`, `noUnusedParameters`, `noImplicitReturns`, `exactOptionalPropertyTypes`.
- ESLint: `typescript-eslint` strict + type-checked, `eslint-plugin-sonarjs`. Zero errors, zero warnings on merge.
- Prettier formats everything; no style debates.
- Knip reports zero unused files, exports and dependencies.
- **Write only what the current issue needs.** No speculative features, no "future-proof" abstractions, no helper used once, no unused parameters or exports.
- Follow an existing pattern in the repo before inventing a new one.
- Names say what a thing is: `scoreLead`, `PhoneType`, `CallAttemptRepository`. No `utils.ts`, `helpers.ts` or `misc` folders.
- Functions do one thing. Cognitive complexity per function ≤ 15 (sonarjs default).
- No `any`. No non-null assertions (`!`) outside tests. No `// @ts-ignore`.
- Validate every outside input with Zod at the boundary (HTTP body, Apify item, LLM output, Vapi payload, env). Inside the boundary, trust the types.
- Outside services only through a port in `apps/api/src/adapters/` (ADR-0007).
- Money as `Decimal`, times stored in UTC, shown in Asia/Karachi.
- No new dependency without the founder's approval in the PR description.

## 2. Git and GitHub

- `main` is protected: no direct pushes; merge only through a pull request with green CI.
- One issue → one branch → one PR. Branch names: `feat/<issue>-<slug>`, `fix/<issue>-<slug>`, `chore/<issue>-<slug>`, `docs/<issue>-<slug>`.
- Conventional commits, enforced by commitlint: `feat:`, `fix:`, `test:`, `docs:`, `refactor:`, `chore:`, `ci:`. Subject in the imperative, ≤ 72 characters.
- Squash-merge; the squash message is the PR title in conventional form.
- Tags: `v0.1.0` end of Cycle 1, `v0.2.0` Cycle 2, `v0.3.0` Cycle 3 (HazelJS submission), `v1.0.0` Cycle 4.

## 3. Testing

- Every behaviour change has a test. A bug fix starts with a failing test that reproduces it.
- Test behaviour through public functions, not internals. Arrange–act–assert.
- Fake only ports (adapters). Never mock the database in integration tests — use the Docker Postgres.
- Coverage ≥ 80% lines on `scoring/`, `policies/` and `adapters/`.
- Agent changes run the eval set (`evals/`).
- Test data is fictional. Never commit real business data, phone numbers, recordings or transcripts.

## 4. Pull requests

- Use the PR template. Link the issue (`Closes #12`) and the FR/NFR it implements.
- Keep PRs small: aim under 400 changed lines excluding generated files and migrations.
- Before requesting review: typecheck, lint, Knip, tests green locally; self-review the full diff; run the `reviewer` subagent.
- Screenshots for dashboard changes.

## 5. Database

- Every schema change is a Prisma migration committed with the PR (`/db-change` skill).
- Never edit an applied migration. Fix forward with a new one.
- Destructive changes (drop column/table) need an ADR.

## 6. Definition of done

**Issue:** acceptance criteria pass as automated tests · typecheck, lint, Knip clean · CI green · reviewed · docs updated where behaviour changed.

**Cycle:** all issues done · integration tests pass across earlier cycles · one end-to-end demo run succeeds · sprint review recorded · retro written in `docs/retros/cycle-N.md`.

## 7. Change control — how scope stays as decided

1. The PRD (`docs/prd.md`) and accepted ADRs are the source of truth.
2. A change in **scope** (new feature, new channel, new service) needs: a PRD update with a changelog row, a version bump, and the founder's approval — before code.
3. A change in **how** (library, pattern, data store) needs a new ADR that supersedes the old one — before code.
4. A PR that does something not traceable to an FR, NFR or issue is closed, not merged.
5. Out-of-scope ideas go into `docs/prd.md` → Future versions, never into code.
