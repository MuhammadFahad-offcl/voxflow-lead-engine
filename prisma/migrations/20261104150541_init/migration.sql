-- Added by hand (docs/database.md, First migration checklist): "Service"."embedding" needs the vector type.
CREATE EXTENSION IF NOT EXISTS vector;

-- CreateEnum
CREATE TYPE "CampaignStatus" AS ENUM ('DISCOVERING', 'ENRICHING', 'SCORING', 'SCRIPTING', 'AWAITING_APPROVAL', 'CALLING', 'COMPLETED', 'PAUSED', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('DISCOVERED', 'FILTERED_OUT', 'ENRICHED', 'SCORED', 'NO_STRONG_SIGNAL', 'NEEDS_REVIEW', 'READY_TO_CALL', 'IN_CALLING', 'BOOKED', 'CLOSED', 'FAILED');

-- CreateEnum
CREATE TYPE "Tier" AS ENUM ('HOT', 'WARM', 'COLD');

-- CreateEnum
CREATE TYPE "PhoneType" AS ENUM ('MOBILE', 'LANDLINE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "WebsiteStatus" AS ENUM ('NONE', 'PENDING', 'READ_FETCH', 'READ_LIGHTPANDA', 'UNREADABLE');

-- CreateEnum
CREATE TYPE "SignalDimension" AS ENUM ('PAIN', 'FIT', 'REACHABILITY', 'ABILITY_TO_PAY');

-- CreateEnum
CREATE TYPE "CallAttemptStatus" AS ENUM ('SCHEDULED', 'DIALING', 'ENDED', 'DENIED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "CallResult" AS ENUM ('BOOKED', 'INTERESTED_NOT_BOOKED', 'CALLBACK_REQUESTED', 'NOT_DECISION_MAKER', 'NOT_INTERESTED', 'NO_ANSWER', 'WRONG_NUMBER', 'DO_NOT_CALL', 'FAILED');

-- CreateEnum
CREATE TYPE "ReasonCode" AS ENUM ('NO_BUDGET', 'HAS_SOLUTION', 'NOT_NEEDED', 'BAD_TIMING', 'DISTRUSTS_AI', 'OTHER');

-- CreateEnum
CREATE TYPE "CallWindow" AS ENUM ('MORNING', 'AFTERNOON');

-- CreateEnum
CREATE TYPE "DoNotCallSource" AS ENUM ('CALL_REQUEST', 'MANUAL');

-- CreateEnum
CREATE TYPE "CostService" AS ENUM ('APIFY', 'PERPLEXITY_SEARCH', 'PERPLEXITY_EMBEDDINGS', 'LLM', 'VAPI');

-- CreateTable
CREATE TABLE "Organization" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Organization_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "callingHours" JSONB NOT NULL,
    "booking" JSONB NOT NULL,
    "spendCaps" JSONB NOT NULL,
    "llmModels" JSONB NOT NULL,
    "retentionDays" INTEGER NOT NULL DEFAULT 90,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "NicheProfile" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "name" TEXT NOT NULL,
    "searchTerms" TEXT[],
    "categoryKeywords" TEXT[],
    "idealClient" JSONB NOT NULL,
    "signalWeights" JSONB NOT NULL,
    "premiumAreas" TEXT[],
    "scriptTemplate" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "NicheProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Campaign" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nicheProfileId" TEXT NOT NULL,
    "city" TEXT NOT NULL,
    "areas" TEXT[],
    "status" "CampaignStatus" NOT NULL DEFAULT 'DISCOVERING',
    "maxResultsPerSearch" INTEGER NOT NULL DEFAULT 100,
    "searchCount" INTEGER NOT NULL DEFAULT 0,
    "foundCount" INTEGER NOT NULL DEFAULT 0,
    "duplicateCount" INTEGER NOT NULL DEFAULT 0,
    "filteredCount" INTEGER NOT NULL DEFAULT 0,
    "approvalRunId" TEXT,
    "approvalNote" TEXT,
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Campaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "placeId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT,
    "address" TEXT,
    "area" TEXT,
    "city" TEXT,
    "mapsUrl" TEXT,
    "rating" DECIMAL(2,1),
    "reviewCount" INTEGER,
    "rawPlace" JSONB NOT NULL,
    "phone" TEXT,
    "phoneType" "PhoneType" NOT NULL DEFAULT 'UNKNOWN',
    "website" TEXT,
    "websiteStatus" "WebsiteStatus" NOT NULL DEFAULT 'PENDING',
    "emails" TEXT[],
    "whatsappLinks" TEXT[],
    "socialLinks" TEXT[],
    "hasOnlineBooking" BOOLEAN,
    "hasChatWidget" BOOLEAN,
    "decisionMakerName" TEXT,
    "businessContext" JSONB,
    "score" INTEGER,
    "scoreBreakdown" JSONB,
    "tier" "Tier",
    "status" "LeadStatus" NOT NULL DEFAULT 'DISCOVERED',
    "filterReason" TEXT,
    "failedStep" TEXT,
    "error" TEXT,
    "graphRunId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "externalId" TEXT,
    "author" TEXT,
    "text" TEXT NOT NULL,
    "rating" INTEGER,
    "publishedAt" TIMESTAMP(3),
    "ownerReplied" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Signal" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "dimension" "SignalDimension" NOT NULL,
    "key" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "evidence" TEXT NOT NULL,
    "sourceUrl" TEXT,
    "reviewId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Signal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Service" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "nameUrdu" TEXT NOT NULL,
    "problem" TEXT NOT NULL,
    "fittingSignals" TEXT[],
    "expectedResult" TEXT NOT NULL,
    "expectedResultUrdu" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "embedding" vector(1024),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Service_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Solution" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "serviceId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "signalIds" TEXT[],
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Solution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Script" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "nicheVersion" INTEGER NOT NULL,
    "variables" JSONB NOT NULL,
    "text" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Script_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CallAttempt" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "attemptNumber" INTEGER NOT NULL,
    "status" "CallAttemptStatus" NOT NULL DEFAULT 'SCHEDULED',
    "window" "CallWindow" NOT NULL,
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "vapiCallId" TEXT,
    "failedRetries" INTEGER NOT NULL DEFAULT 0,
    "deniedBy" TEXT,
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "result" "CallResult",
    "reasonCode" "ReasonCode",
    "remarks" TEXT,
    "callbackAt" TIMESTAMP(3),
    "decisionMakerName" TEXT,
    "transcript" TEXT,
    "recordingUrl" TEXT,
    "durationSec" INTEGER,
    "costUsd" DECIMAL(10,4),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CallAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Meeting" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "callAttemptId" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "endAt" TIMESTAMP(3) NOT NULL,
    "calendarEventId" TEXT NOT NULL,
    "meetLink" TEXT NOT NULL,
    "confirmationSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Meeting_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DoNotCall" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "source" "DoNotCallSource" NOT NULL,
    "addedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DoNotCall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CostRecord" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "service" "CostService" NOT NULL,
    "amountUsd" DECIMAL(10,5) NOT NULL,
    "units" INTEGER,
    "note" TEXT,
    "leadId" TEXT,
    "campaignId" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CostRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_contexts" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "agentId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "input" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "steps" JSONB NOT NULL,
    "conversationHistory" JSONB NOT NULL,
    "workingMemory" JSONB NOT NULL,
    "facts" JSONB NOT NULL,
    "entities" JSONB NOT NULL,
    "ragContext" JSONB,
    "metadata" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "agent_contexts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_steps" (
    "id" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepNumber" INTEGER NOT NULL,
    "state" TEXT NOT NULL,
    "action" JSONB,
    "result" JSONB,
    "error" TEXT,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "duration" INTEGER,

    CONSTRAINT "agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_sessions" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "userId" TEXT,
    "agentId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "agent_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_runs" (
    "id" TEXT NOT NULL,
    "agentName" TEXT NOT NULL,
    "agentVersion" TEXT,
    "status" TEXT NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "error" JSONB,
    "tenantId" TEXT,
    "userId" TEXT,
    "parentRunId" TEXT,
    "rootRunId" TEXT NOT NULL,
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "checkpointId" TEXT,
    "leaseOwner" TEXT,
    "leaseExpiresAt" TIMESTAMP(3),
    "leaseToken" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "metadata" JSONB,

    CONSTRAINT "agent_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_run_checkpoints" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "step" INTEGER,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_run_checkpoints_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_human_tasks" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "toolName" TEXT,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "resolvedBy" TEXT,
    "metadata" JSONB,

    CONSTRAINT "agent_human_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "agent_a2a_tasks" (
    "id" TEXT NOT NULL,
    "taskJson" JSONB,
    "executionId" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "agent_a2a_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Settings_organizationId_key" ON "Settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "NicheProfile_organizationId_slug_version_key" ON "NicheProfile"("organizationId", "slug", "version");

-- CreateIndex
CREATE INDEX "Campaign_organizationId_status_idx" ON "Campaign"("organizationId", "status");

-- CreateIndex
CREATE INDEX "Lead_campaignId_status_idx" ON "Lead"("campaignId", "status");

-- CreateIndex
CREATE INDEX "Lead_organizationId_phone_idx" ON "Lead"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "Lead_tier_score_idx" ON "Lead"("tier", "score");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_organizationId_placeId_key" ON "Lead"("organizationId", "placeId");

-- CreateIndex
CREATE INDEX "Review_leadId_idx" ON "Review"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Review_leadId_externalId_key" ON "Review"("leadId", "externalId");

-- CreateIndex
CREATE UNIQUE INDEX "Signal_leadId_key_key" ON "Signal"("leadId", "key");

-- CreateIndex
CREATE UNIQUE INDEX "Service_organizationId_slug_key" ON "Service"("organizationId", "slug");

-- CreateIndex
CREATE UNIQUE INDEX "Solution_leadId_key" ON "Solution"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "Script_leadId_key" ON "Script"("leadId");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_idempotencyKey_key" ON "CallAttempt"("idempotencyKey");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_vapiCallId_key" ON "CallAttempt"("vapiCallId");

-- CreateIndex
CREATE INDEX "CallAttempt_status_scheduledAt_idx" ON "CallAttempt"("status", "scheduledAt");

-- CreateIndex
CREATE UNIQUE INDEX "CallAttempt_leadId_attemptNumber_key" ON "CallAttempt"("leadId", "attemptNumber");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_callAttemptId_key" ON "Meeting"("callAttemptId");

-- CreateIndex
CREATE UNIQUE INDEX "Meeting_calendarEventId_key" ON "Meeting"("calendarEventId");

-- CreateIndex
CREATE UNIQUE INDEX "DoNotCall_organizationId_phone_key" ON "DoNotCall"("organizationId", "phone");

-- CreateIndex
CREATE INDEX "CostRecord_organizationId_service_at_idx" ON "CostRecord"("organizationId", "service", "at");

-- CreateIndex
CREATE UNIQUE INDEX "agent_contexts_executionId_key" ON "agent_contexts"("executionId");

-- CreateIndex
CREATE INDEX "agent_contexts_sessionId_idx" ON "agent_contexts"("sessionId");

-- CreateIndex
CREATE INDEX "agent_contexts_userId_idx" ON "agent_contexts"("userId");

-- CreateIndex
CREATE INDEX "agent_contexts_agentId_idx" ON "agent_contexts"("agentId");

-- CreateIndex
CREATE INDEX "agent_contexts_state_idx" ON "agent_contexts"("state");

-- CreateIndex
CREATE INDEX "agent_contexts_createdAt_idx" ON "agent_contexts"("createdAt");

-- CreateIndex
CREATE INDEX "agent_contexts_deletedAt_idx" ON "agent_contexts"("deletedAt");

-- CreateIndex
CREATE INDEX "agent_steps_executionId_idx" ON "agent_steps"("executionId");

-- CreateIndex
CREATE INDEX "agent_steps_timestamp_idx" ON "agent_steps"("timestamp");

-- CreateIndex
CREATE UNIQUE INDEX "agent_sessions_sessionId_key" ON "agent_sessions"("sessionId");

-- CreateIndex
CREATE INDEX "agent_sessions_userId_idx" ON "agent_sessions"("userId");

-- CreateIndex
CREATE INDEX "agent_sessions_agentId_idx" ON "agent_sessions"("agentId");

-- CreateIndex
CREATE INDEX "agent_sessions_createdAt_idx" ON "agent_sessions"("createdAt");

-- CreateIndex
CREATE INDEX "agent_runs_agentName_idx" ON "agent_runs"("agentName");

-- CreateIndex
CREATE INDEX "agent_runs_status_idx" ON "agent_runs"("status");

-- CreateIndex
CREATE INDEX "agent_runs_tenantId_idx" ON "agent_runs"("tenantId");

-- CreateIndex
CREATE INDEX "agent_runs_rootRunId_idx" ON "agent_runs"("rootRunId");

-- CreateIndex
CREATE INDEX "agent_runs_updatedAt_idx" ON "agent_runs"("updatedAt");

-- CreateIndex
CREATE INDEX "agent_runs_leaseExpiresAt_idx" ON "agent_runs"("leaseExpiresAt");

-- CreateIndex
CREATE INDEX "agent_run_checkpoints_runId_idx" ON "agent_run_checkpoints"("runId");

-- CreateIndex
CREATE INDEX "agent_run_checkpoints_runId_createdAt_idx" ON "agent_run_checkpoints"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "agent_human_tasks_runId_idx" ON "agent_human_tasks"("runId");

-- CreateIndex
CREATE INDEX "agent_human_tasks_status_idx" ON "agent_human_tasks"("status");

-- AddForeignKey
ALTER TABLE "Settings" ADD CONSTRAINT "Settings_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NicheProfile" ADD CONSTRAINT "NicheProfile_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Campaign" ADD CONSTRAINT "Campaign_nicheProfileId_fkey" FOREIGN KEY ("nicheProfileId") REFERENCES "NicheProfile"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Signal" ADD CONSTRAINT "Signal_reviewId_fkey" FOREIGN KEY ("reviewId") REFERENCES "Review"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Service" ADD CONSTRAINT "Service_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Solution" ADD CONSTRAINT "Solution_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Solution" ADD CONSTRAINT "Solution_serviceId_fkey" FOREIGN KEY ("serviceId") REFERENCES "Service"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Script" ADD CONSTRAINT "Script_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CallAttempt" ADD CONSTRAINT "CallAttempt_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Meeting" ADD CONSTRAINT "Meeting_callAttemptId_fkey" FOREIGN KEY ("callAttemptId") REFERENCES "CallAttempt"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DoNotCall" ADD CONSTRAINT "DoNotCall_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostRecord" ADD CONSTRAINT "CostRecord_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "Organization"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostRecord" ADD CONSTRAINT "CostRecord_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CostRecord" ADD CONSTRAINT "CostRecord_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "Campaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "agent_steps" ADD CONSTRAINT "agent_steps_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "agent_contexts"("executionId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Added by hand (docs/database.md, First migration checklist): Prisma cannot express these two.
ALTER TABLE "CallAttempt" ADD CONSTRAINT attempt_number_1_or_2 CHECK ("attemptNumber" IN (1, 2));

CREATE INDEX service_embedding_hnsw ON "Service" USING hnsw (embedding vector_cosine_ops);
