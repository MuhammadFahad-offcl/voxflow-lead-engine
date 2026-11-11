-- AlterTable
ALTER TABLE "Review" ADD COLUMN     "labels" TEXT[] DEFAULT ARRAY[]::TEXT[];
