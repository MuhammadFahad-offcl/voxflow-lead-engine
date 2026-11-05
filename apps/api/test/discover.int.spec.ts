/**
 * Integration test of the discover step on real Postgres with the fake lead source.
 *
 * Serves: FR-5 to FR-8, FR-33, NFR-1, NFR-2; issue #10 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { DiscoveryRepository, type Claim } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createLogger } from '../src/logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from '../src/pipeline/area-polygons.js';
import { discoverCampaign, type DiscoverDeps } from '../src/pipeline/discover.step.js';
import type { CollectedRun, LeadSourcePort, PlaceSearch } from '../src/ports/lead-source.port.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const logger = createLogger('error');
const organizationId = SEED_ORGANIZATION_ID;
const polygons = loadAreaPolygons(AREAS_DIR);

let prisma: PrismaProvider;
let repository: DiscoveryRepository;

/** The fake lead source, plus counters. */
class SpyLeadSource implements LeadSourcePort {
  starts: PlaceSearch[] = [];
  collects: string[] = [];
  private readonly fake = new FakeLeadSourceAdapter(logger);

  chargeLimitUsd(maxResults: number): Prisma.Decimal {
    return this.fake.chargeLimitUsd(maxResults);
  }

  async start(search: PlaceSearch): Promise<string> {
    this.starts.push(search);
    return this.fake.start(search);
  }

  async collect(runId: string): Promise<CollectedRun> {
    this.collects.push(runId);
    return this.fake.collect(runId);
  }
}

const deps = (leadSource: LeadSourcePort): DiscoverDeps => ({
  repository,
  leadSource,
  polygons,
  logger,
  now: () => new Date(),
});

const newCampaign = async (areas: string[] = ['DHA']): Promise<Claim> => {
  const niche = await prisma.nicheProfile.findFirstOrThrow({ where: { organizationId } });
  const claimedAt = new Date();
  const { id } = await prisma.campaign.create({
    data: {
      organizationId,
      nicheProfileId: niche.id,
      city: 'Lahore',
      areas,
      searchCount: niche.searchTerms.length * areas.length,
      discoveryClaimedAt: claimedAt,
    },
  });
  return { id, claimedAt };
};

const setApifyCap = async (apifyDailyUsd: string): Promise<void> => {
  const { spendCaps } = await prisma.settings.findUniqueOrThrow({ where: { organizationId } });
  await prisma.settings.update({
    where: { organizationId },
    data: { spendCaps: { ...(spendCaps as Prisma.JsonObject), apifyDailyUsd } },
  });
};

const campaignRow = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const costs = (campaignId: string) =>
  prisma.costRecord.findMany({ where: { campaignId }, orderBy: { at: 'asc' } });
const lead = (placeId: string) =>
  prisma.lead.findUniqueOrThrow({
    where: { organizationId_placeId: { organizationId, placeId } },
  });

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_discover_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  repository = new DiscoveryRepository(prisma);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.costRecord.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.campaign.deleteMany();
  await setApifyCap('2.00');
});

// Proves the fixture campaign's numbers from issue #10, and what each stored lead looks like.
describe('discoverCampaign: the fixture campaign', () => {
  it('ends in ENRICHING with 12 found, 1 duplicate, 2 filtered', async () => {
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(new SpyLeadSource()), claim)).resolves.toBe('ENRICHING');

    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'ENRICHING',
      foundCount: 12,
      duplicateCount: 1,
      filteredCount: 2,
      discoveryClaimedAt: null,
    });
    expect(await prisma.lead.count({ where: { campaignId: claim.id } })).toBe(11);
  });

  it('runs one search per term, each with the polygon, cap and charge limit', async () => {
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), await newCampaign());

    expect(leadSource.starts.map((search) => search.term)).toEqual([
      'dental clinic',
      'dentist',
      'dental surgeon',
      'orthodontist',
    ]);
    expect(leadSource.starts[0]).toMatchObject({
      area: 'DHA',
      city: 'Lahore',
      maxResults: 100,
      polygon: { type: 'Polygon' },
    });
    expect(leadSource.starts[0]?.chargeLimitUsd.toFixed(2)).toBe('0.61');
  });

  it('keeps the hospital and the 3.6 clinic as FILTERED_OUT with their rule', async () => {
    await discoverCampaign(deps(new SpyLeadSource()), await newCampaign());

    expect(await lead('fictional-place-p04')).toMatchObject({
      status: 'FILTERED_OUT',
      filterReason: 'not a private clinic: category "Hospital"',
    });
    expect(await lead('fictional-place-p05')).toMatchObject({
      status: 'FILTERED_OUT',
      filterReason: 'rating 3.6 is below the minimum 4',
    });
  });

  it('passes the boundary clinic at 4.0 stars and 30 reviews', async () => {
    await discoverCampaign(deps(new SpyLeadSource()), await newCampaign());

    expect(await lead('fictional-place-p11')).toMatchObject({
      status: 'DISCOVERED',
      filterReason: null,
    });
  });

  it('records one CostRecord per search with its term, area and true charge', async () => {
    const claim = await newCampaign();

    await discoverCampaign(deps(new SpyLeadSource()), claim);

    const records = await costs(claim.id);
    expect(records).toHaveLength(4);
    expect(records.every((record) => record.service === 'APIFY')).toBe(true);
    expect(records.filter((record) => record.units === 12)).toHaveLength(1);
    expect(records.filter((record) => record.units === 0)).toHaveLength(3);
    expect(
      records.reduce((sum, record) => sum.plus(record.amountUsd), new Prisma.Decimal(0)).toFixed(3),
    ).toBe('0.072');
    expect(records.some((record) => record.note?.includes('dental surgeon'))).toBe(true);
    expect(records.every((record) => record.note?.includes('DHA'))).toBe(true);
  });
});
