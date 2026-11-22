/**
 * A demo campaign on the fictional DHA clinics, discovered and with its pass-2 reviews
 * stored, all through the fake adapters. Its leads are ready for the lead graph.
 *
 * Serves: FR-36 (demo mode); issue #15 tests, issue #19 (the solution recorder and its replay).
 * Used by: apps/api/src/llm-record-solution.ts; apps/api/test/lead-run.int.spec.ts,
 * apps/api/test/lead-graph.int.spec.ts, apps/api/test/lead-runner.int.spec.ts,
 * apps/api/test/log-privacy.int.spec.ts, apps/api/test/solution-replay.int.spec.ts.
 */
import { resolve } from 'node:path';
import { FakeLeadSourceAdapter } from '../adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../adapters/web-reader/fake.adapter.js';
import { DiscoveryRepository } from '../db/discovery.repository.js';
import type { PrismaProvider } from '../db/prisma.provider.js';
import { ReviewRepository } from '../db/review.repository.js';
import { SEED_ORGANIZATION_ID, embedMissingServices, seed } from '../db/seed.js';
import type { Logger } from '../logging/logger.js';
import type { EmbeddingPort } from '../ports/embedding.port.js';
import { buildLeadRunnerDeps, runLeadRunnerOnce } from '../scheduler/lead-runner.js';
import { AREAS_DIR, loadAreaPolygons } from './area-polygons.js';
import { discoverCampaign } from './discover.step.js';
import { enrichReviewsForCampaign } from './enrich-reviews.step.js';
import { PaidStartGate } from './paid-start-gate.js';

/**
 * Creates a DHA campaign on the seeded niche, discovers it and, unless told not to, stores its
 * reviews.
 *
 * Does not seed: call `seed` first. Does not enrich, label or score.
 * @param prisma - A client on a seeded test database.
 * @param logger - A silent logger.
 * @param withReviews - False leaves the reviews to the lead runner's reviews step.
 * @returns `Campaign.id`; the campaign is ENRICHING.
 * @throws Prisma's not-found error when the database is not seeded; what discover or the reviews
 * pass throw.
 */
export async function discoverDemoCampaign(
  prisma: PrismaProvider,
  logger: Logger,
  withReviews = true,
): Promise<string> {
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  const claimedAt = new Date();
  const { id } = await prisma.campaign.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      nicheProfileId: niche.id,
      city: 'Lahore',
      areas: ['DHA'],
      searchCount: niche.searchTerms.length,
      discoveryClaimedAt: claimedAt,
    },
  });
  const leadSource = new FakeLeadSourceAdapter(logger);
  const discovery = new DiscoveryRepository(prisma);
  await discoverCampaign(
    {
      repository: discovery,
      leadSource,
      polygons: loadAreaPolygons(AREAS_DIR),
      logger,
      now: () => new Date(),
      startGate: new PaidStartGate(),
    },
    { id, claimedAt },
  );
  if (withReviews) {
    await enrichReviewsForCampaign(
      { prisma, reviewRepo: new ReviewRepository(prisma, discovery), leadSource, logger },
      id,
    );
  }
  return id;
}

/**
 * Builds the scored DHA demo clinics from an empty database: seeds it, embeds the catalog, discovers
 * the demo campaign and runs every lead to SCORE with the fake adapters (labelling replays its
 * recorded answers).
 *
 * The solution recorder and its replay test both start here, so the prompts the test replays are
 * the ones that were recorded. Does not run the solution agent.
 * @param prisma - A client on an empty, migrated database (never the dev one).
 * @param logger - Usually a quiet logger: the demo pipeline logs every step.
 * @param embedder - The fake embedder; the agent's catalog search must use the same one.
 * @returns The WARM and HOT leads, sorted by place id.
 * @throws What seeding, embedding, discovery or the lead runner throw.
 */
export async function scoreDemoClinics(
  prisma: PrismaProvider,
  logger: Logger,
  embedder: EmbeddingPort,
): Promise<{ id: string; placeId: string }[]> {
  await seed(prisma, resolve(import.meta.dirname, '../../../../config'));
  await embedMissingServices(prisma, { demoMode: true, embedder, logger });
  await discoverDemoCampaign(prisma, logger);
  const deps = buildLeadRunnerDeps({
    prisma,
    leadSource: new FakeLeadSourceAdapter(logger),
    webReader: new FakeWebReaderAdapter(),
    webContext: new FakeWebContextAdapter(),
    llm: new FakeLlmAdapter(),
    logger,
    now: () => new Date(),
    concurrency: 4,
    startGate: new PaidStartGate(),
  });
  // Until no lead is left to claim: every lead then sits at its last step (SCORE or an exit).
  while ((await runLeadRunnerOnce(deps)).leads > 0);
  return prisma.lead.findMany({
    where: { tier: { in: ['WARM', 'HOT'] } },
    orderBy: { placeId: 'asc' },
    select: { id: true, placeId: true },
  });
}
