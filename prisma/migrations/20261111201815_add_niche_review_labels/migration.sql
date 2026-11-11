-- AlterTable
ALTER TABLE "NicheProfile" ADD COLUMN     "reviewLabels" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- Backfill (#13): every stored dental-clinic version (v1 to v3) was seeded from a file with exactly
-- these labels, so the rows get what their file always said. Other niches have none yet.
UPDATE "NicheProfile"
SET "reviewLabels" = ARRAY['PHONE_UNANSWERED', 'BOOKING_OR_WAIT', 'STAFF_OR_SERVICE', 'PRICE', 'POSITIVE', 'OTHER']::TEXT[]
WHERE "slug" = 'dental-clinic';
