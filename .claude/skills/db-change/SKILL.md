---
name: db-change
description: Safely change the database schema with Prisma 7 migrations. Use whenever prisma/schema.prisma needs to change.
---

# Change the database schema

1. **Justify.** The change must trace to an FR/NFR or ADR. If it changes an invariant in `docs/database.md`, write an ADR first (`adr` skill).
2. **Edit** `prisma/schema.prisma` only. Run `pnpm prisma format` and `pnpm prisma validate`.
3. **Create the migration without applying it:** `pnpm prisma migrate dev --create-only --name <snake_case_change>`.
4. **Read the generated SQL.** Add by hand anything Prisma cannot express: `CHECK` constraints, pgvector indexes, data backfills. Never drop a column with data in the same PR that stops using it — deprecate first.
5. **Apply:** `pnpm prisma migrate dev`, then `pnpm prisma generate` (Prisma 7 does not auto-generate).
6. **Update** Zod schemas in `packages/shared` for any JSON column, the seed script if defaults changed, and `docs/database.md`.
7. **Test** with an integration test that exercises the new constraint.
8. **One migration per PR.** Never edit or delete a migration that is already on `main`; write a new one.

Never run `prisma migrate reset` or `prisma db push` — they are denied in `.claude/settings.json`.
