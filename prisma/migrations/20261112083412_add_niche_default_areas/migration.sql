-- AlterTable
ALTER TABLE "NicheProfile" ADD COLUMN     "defaultAreas" TEXT[] DEFAULT ARRAY[]::TEXT[];
