-- AlterTable (#14): NicheProfile.tiers holds the niche's score thresholds (FR-15).
-- Written by hand: added as nullable, backfilled, then made required, because rows exist.
ALTER TABLE "NicheProfile" ADD COLUMN "tiers" JSONB;

-- Backfill: every stored dental-clinic version (v1 to v3) was seeded from a file with exactly
-- these thresholds. A row of another niche would stay NULL and stop the next statement, on purpose.
UPDATE "NicheProfile" SET "tiers" = '{"hot": 70, "warm": 45}'::jsonb WHERE "slug" = 'dental-clinic';

ALTER TABLE "NicheProfile" ALTER COLUMN "tiers" SET NOT NULL;
