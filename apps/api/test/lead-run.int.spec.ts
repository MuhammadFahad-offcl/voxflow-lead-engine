/**
 * Integration tests of the lead runner's claim on the fictional DHA demo clinics: atomic, leased,
 * and only for leads whose reviews are settled, so the paid reviews run is never bought twice.
 *
 * Serves: FR-32, NFR-1, NFR-2, ADR-0002; issue #15.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import { LeadRunRepository } from '../src/db/lead-run.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { NO_REVIEWS_ERROR, ReviewRepository } from '../src/db/review.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { discoverDemoCampaign } from './demo-campaign.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const LEASE_MS = 15 * 60 * 1000;
let prisma: PrismaProvider;
let campaignId: string;
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

const runs = () => new LeadRunRepository(prisma);

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_lead_run_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  campaignId = await discoverDemoCampaign(prisma, logger);
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

const unclaimAll = () =>
  prisma.lead.updateMany({ where: { campaignId }, data: { graphClaimedAt: null } });

// Proves the runner's claim: atomic, leased, and only for leads whose reviews are settled.
describe('LeadRunRepository.claimNext', () => {
  it('gives two passes at the same moment different leads', async () => {
    const now = new Date();
    const [first, second] = await Promise.all([
      runs().claimNext(now, LEASE_MS, 3),
      runs().claimNext(now, LEASE_MS, 3),
    ]);
    const ids = [...first, ...second].map((lead) => lead.id);

    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(0);
    await unclaimAll();
  });

  it('takes a claimed lead again only after its lease runs out', async () => {
    const start = new Date();
    const [held] = await runs().claimNext(start, LEASE_MS, 1);
    const all = 100;

    const during = await runs().claimNext(new Date(start.getTime() + 1000), LEASE_MS, all);
    const after = await runs().claimNext(new Date(start.getTime() + LEASE_MS + 1), LEASE_MS, all);

    expect(during.map((lead) => lead.id)).not.toContain(held?.id);
    expect(after.map((lead) => lead.id)).toContain(held?.id);
    await unclaimAll();
  });

  it('waits for a lead with no reviews until its paid run is known to have found none', async () => {
    const { id } = await prisma.lead.create({
      data: {
        organizationId: SEED_ORGANIZATION_ID,
        campaignId,
        placeId: 'fictional-place-no-reviews',
        name: 'Fictional Clinic Without Reviews',
        rawPlace: {},
      },
    });
    const claimedIds = async () =>
      (await runs().claimNext(new Date(), LEASE_MS, 100)).map((l) => l.id);

    expect(await claimedIds()).not.toContain(id);
    await unclaimAll();
    await prisma.lead.update({ where: { id }, data: { error: NO_REVIEWS_ERROR } });
    expect(await claimedIds()).toContain(id);
    await unclaimAll();
    await prisma.lead.update({ where: { id }, data: { status: 'FILTERED_OUT' } });
  });

  it('never sends a lead that started its graph back to the paid reviews run', async () => {
    const { id } = await prisma.lead.create({
      data: {
        organizationId: SEED_ORGANIZATION_ID,
        campaignId,
        placeId: 'fictional-place-failed-after-reviews',
        name: 'Fictional Clinic That Failed Later',
        rawPlace: {},
      },
    });
    const reviews = new ReviewRepository(prisma, new DiscoveryRepository(prisma));
    const needing = async () => (await reviews.leadsNeedingReviews(campaignId)).map((l) => l.id);

    expect(await needing()).toContain(id);
    // Its graph ran, then failed: the failure replaced the "no reviews" mark.
    await prisma.lead.update({
      where: { id },
      data: { graphRunId: 'lead_fictional', status: 'FAILED', error: 'Fictional failure' },
    });
    expect(await needing()).not.toContain(id);
    await prisma.lead.update({ where: { id }, data: { status: 'FILTERED_OUT' } });
  });

  it('claims nothing from a paused campaign', async () => {
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'PAUSED', pausedFrom: 'ENRICHING' },
    });

    expect(await runs().claimNext(new Date(), LEASE_MS, 100)).toEqual([]);
    await prisma.campaign.update({
      where: { id: campaignId },
      data: { status: 'ENRICHING', pausedFrom: null },
    });
  });
});
