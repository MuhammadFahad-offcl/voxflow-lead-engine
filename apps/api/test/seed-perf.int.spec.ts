/**
 * Integration tests of the performance seed on a test database: fictional, finished leads whose
 * scores equal their signals' points, written once, touching nothing else.
 *
 * Serves: NFR-3 (the 5,000-lead timing needs this data), FR-14 (score = sum of signals); issue #16.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed } from '../src/db/seed.js';
import { seedPerfCampaign } from '../src/db/seed-perf.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_seed_perf_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the perf data is safe for a dev database and consistent with the score invariant.
describe('seedPerfCampaign', () => {
  it('adds fictional, finished leads once, each score the sum of its signals', async () => {
    const first = await seedPerfCampaign(prisma, 200);
    const second = await seedPerfCampaign(prisma, 200);

    expect(first).toMatchObject({ added: true, leads: 200 });
    expect(second).toEqual({ campaignId: first.campaignId, added: false, leads: 200 });
    const leads = await prisma.lead.findMany({
      where: { campaignId: first.campaignId },
      include: { signals: true },
    });
    expect(leads).toHaveLength(200);
    // Nothing the lead runner would claim, nothing that looks like a real business.
    expect(new Set(leads.map((lead) => lead.status))).toEqual(
      new Set(['SCORED', 'FAILED', 'FILTERED_OUT']),
    );
    expect(
      leads.every((lead) => lead.placeId.startsWith('fictional-perf-') && lead.phone === null),
    ).toBe(true);
    for (const lead of leads.filter((row) => row.status === 'SCORED')) {
      const points = lead.signals.reduce((sum, signal) => sum + signal.points, 0);
      expect({ place: lead.placeId, points }).toEqual({ place: lead.placeId, points: lead.score });
    }
    const campaign = await prisma.campaign.findUniqueOrThrow({ where: { id: first.campaignId } });
    expect(campaign.status).toBe('SCORING');
  });
});
