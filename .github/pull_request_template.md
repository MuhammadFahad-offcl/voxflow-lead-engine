## Summary

<!-- What changed and why, in 1–3 sentences. -->

Closes #

## Traceability

- Requirements: FR- / NFR-
- ADR (if a decision was made or changed):

## How I tested

- [ ] Unit tests
- [ ] Integration test
- [ ] Ran in `DEMO_MODE=true`
- [ ] Manual check (describe):

## Screenshots / recording

<!-- Required for dashboard changes. -->

## Checklist

- [ ] Inside v1 scope (no email, automated WhatsApp, follow-ups, or other Future-versions items)
- [ ] `pnpm typecheck && pnpm lint && pnpm knip && pnpm test` green
- [ ] ≤ 400 changed lines
- [ ] No secrets, real phone numbers, transcripts or lead data
- [ ] External input validated with Zod
- [ ] Docs / `.env.example` / `docs/database.md` updated if needed
- [ ] Schema change follows the `db-change` skill (one migration, not edited after merge)

## Risks / follow-ups
