-- AlterTable
ALTER TABLE "Campaign" ADD COLUMN     "pausedFrom" "CampaignStatus";

-- Added by hand (docs/database.md "Invariants"): pausedFrom is set exactly while the campaign is
-- PAUSED, and only to a status a campaign can be resumed into.
ALTER TABLE "Campaign" ADD CONSTRAINT "campaign_paused_from_only_when_paused" CHECK (
  ("status" = 'PAUSED') = ("pausedFrom" IS NOT NULL)
  AND ("pausedFrom" IS NULL OR "pausedFrom" NOT IN ('PAUSED', 'COMPLETED', 'FAILED'))
);
