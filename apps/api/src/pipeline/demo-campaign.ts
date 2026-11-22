/**
 * A demo campaign on the fictional DHA clinics, discovered and with its pass-2 reviews
 * stored, all through the fake adapters. Its leads are ready for the lead graph.
 *
 * Serves: FR-36 (demo mode); issue #15 tests, issue #19 (the solution recorder).
 * Used by: apps/api/src/llm-record-solution.ts; apps/api/test/lead-run.int.spec.ts,
 * apps/api/test/lead-graph.int.spec.ts, apps/api/test/lead-runner.int.spec.ts,
 * apps/api/test/log-privacy.int.spec.ts.
 */
import { FakeLeadSourceAdapter } from '../adapters/lead-source/fake.adapter.js';
import { DiscoveryRepository } from '../db/discovery.repository.js';
import type { PrismaProvider } from '../db/prisma.provider.js';
import { ReviewRepository } from '../db/review.repository.js';
import { SEED_ORGANIZATION_ID } from '../db/seed.js';
import type { Logger } from '../logging/logger.js';
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
