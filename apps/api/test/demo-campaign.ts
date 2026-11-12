/**
 * Test helper: a demo campaign on the fictional DHA clinics, discovered and with its pass-2 reviews
 * stored, all through the fake adapters. Its leads are ready for the lead graph.
 *
 * Serves: FR-36 (demo mode); issue #15 tests.
 * Used by: apps/api/test/lead-run.int.spec.ts.
 */
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import type { PrismaProvider } from '../src/db/prisma.provider.js';
import { ReviewRepository } from '../src/db/review.repository.js';
import { SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from '../src/pipeline/area-polygons.js';
import { discoverCampaign } from '../src/pipeline/discover.step.js';
import { enrichReviewsForCampaign } from '../src/pipeline/enrich-reviews.step.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';

/**
 * Creates a DHA campaign on the seeded niche, discovers it and stores its reviews.
 *
 * Does not seed: call `seed` first. Does not enrich, label or score.
 * @param prisma - A client on a seeded test database.
 * @param logger - A silent logger.
 * @returns `Campaign.id`; the campaign is ENRICHING.
 * @throws Prisma's not-found error when the database is not seeded; what discover or the reviews
 * pass throw.
 */
export async function discoverDemoCampaign(
  prisma: PrismaProvider,
  logger: Logger,
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
  await enrichReviewsForCampaign(
    { prisma, reviewRepo: new ReviewRepository(prisma, discovery), leadSource, logger },
    id,
  );
  return id;
}
