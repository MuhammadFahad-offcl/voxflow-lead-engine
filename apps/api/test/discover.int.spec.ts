/**
 * Integration test of the discover step on real Postgres with the fake lead source.
 *
 * Serves: FR-5 to FR-8, FR-33, NFR-1, NFR-2; issue #10 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import type { CompassPlaceItem } from '../src/adapters/lead-source/apify-items.js';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { DiscoveryRepository, type Claim } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createLogger } from '../src/logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from '../src/pipeline/area-polygons.js';
import { discoverCampaign, type DiscoverDeps } from '../src/pipeline/discover.step.js';
import { searchNote } from '../src/pipeline/search-plan.js';
import { karachiDayStart } from '../src/pipeline/spend-cap.js';
import type { CollectedRun, LeadSourcePort, PlaceSearch } from '../src/ports/lead-source.port.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const logger = createLogger('error');
const organizationId = SEED_ORGANIZATION_ID;
const polygons = loadAreaPolygons(AREAS_DIR);

let prisma: PrismaProvider;
let repository: DiscoveryRepository;

/** The fake lead source, plus counters and the failures a test asks for. */
class SpyLeadSource implements LeadSourcePort {
  starts: PlaceSearch[] = [];
  collects: string[] = [];
  private readonly fake = new FakeLeadSourceAdapter(logger);

  constructor(
    private readonly hooks: {
      onStart?: (startNumber: number) => Promise<void>;
      onCollect?: (collectNumber: number) => void;
      itemsFor?: (term: string) => CompassPlaceItem[];
    } = {},
  ) {}

  chargeLimitUsd(maxResults: number): Prisma.Decimal {
    return this.fake.chargeLimitUsd(maxResults);
  }

  async start(search: PlaceSearch): Promise<string> {
    this.starts.push(search);
    await this.hooks.onStart?.(this.starts.length);
    return this.fake.start(search);
  }

  async collect(runId: string): Promise<CollectedRun> {
    this.collects.push(runId);
    this.hooks.onCollect?.(this.collects.length);
    const run = await this.fake.collect(runId);
    const term = (JSON.parse(runId) as { term: string }).term;
    return this.hooks.itemsFor === undefined ? run : { ...run, items: this.hooks.itemsFor(term) };
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

// What the resume route does, plus the runner's new claim.
const resume = async (id: string): Promise<Claim> => {
  const claimedAt = new Date();
  await prisma.campaign.update({
    where: { id },
    data: {
      status: 'DISCOVERING',
      pausedFrom: null,
      pauseReason: null,
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

const spendEarlier = (amountUsd: string, at: Date) =>
  prisma.costRecord.create({ data: { organizationId, service: 'APIFY', amountUsd, at } });

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

  it('stores the phone as +92 and the website normalized', async () => {
    await discoverCampaign(deps(new SpyLeadSource()), await newCampaign());

    expect(await lead('fictional-place-p01')).toMatchObject({
      phone: '+923000000001',
      phoneType: 'MOBILE',
      website: 'https://p01.example.com',
      websiteStatus: 'PENDING',
    });
    expect(await lead('fictional-place-p02')).toMatchObject({
      website: null,
      websiteStatus: 'NONE',
    });
  });

  it('keeps bookingLinks and the closed flags in rawPlace', async () => {
    await discoverCampaign(deps(new SpyLeadSource()), await newCampaign());

    expect((await lead('fictional-place-p01')).rawPlace).toMatchObject({
      bookingLinks: [{ name: 'Oladoc' }],
      permanentlyClosed: false,
      temporarilyClosed: false,
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

// Proves FR-7: a place stored by any campaign is skipped and counted, never processed again.
describe('discoverCampaign: a second campaign', () => {
  it('counts every place as a duplicate and leaves the stored leads alone', async () => {
    const first = await newCampaign();
    await discoverCampaign(deps(new SpyLeadSource()), first);
    const second = await newCampaign();

    await discoverCampaign(deps(new SpyLeadSource()), second);

    expect(await campaignRow(second.id)).toMatchObject({
      status: 'ENRICHING',
      foundCount: 12,
      duplicateCount: 12,
      filteredCount: 0,
    });
    expect(await prisma.lead.count()).toBe(11);
    expect(await lead('fictional-place-p01')).toMatchObject({ campaignId: first.id });
  });
});

// Proves the chain rule works across searches, because a chain's branches arrive separately (FR-8).
describe('discoverCampaign: chains', () => {
  it('filters all 3 branches of one name found by different searches', async () => {
    const [template] = await new FakeLeadSourceAdapter(logger)
      .collect(JSON.stringify({ term: 'dental clinic', area: 'DHA', maxResults: 1 }))
      .then((run) => run.items);
    if (template === undefined) throw new Error('No fixture place');
    const branch = (placeId: string): CompassPlaceItem => ({ ...template, placeId });
    const itemsFor = (term: string): CompassPlaceItem[] => {
      if (term === 'dental clinic') return [branch('branch-1'), branch('branch-2')];
      return term === 'dentist' ? [branch('branch-3')] : [];
    };
    const claim = await newCampaign();

    await discoverCampaign(deps(new SpyLeadSource({ itemsFor })), claim);

    expect(await campaignRow(claim.id)).toMatchObject({ foundCount: 3, filteredCount: 3 });
    expect(await lead('branch-1')).toMatchObject({
      status: 'FILTERED_OUT',
      filterReason: 'chain: 3 places with this name in the campaign',
    });
  });
});

// Proves an area with no polygon is refused before any charge (founder decision on Q1).
describe('discoverCampaign: an area with no polygon', () => {
  it('pauses with the area named, having started nothing', async () => {
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign(['DHA', 'Gulberg']);

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(0);
    expect(await costs(claim.id)).toHaveLength(0);
    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'DISCOVERING',
      pauseReason: expect.stringContaining('Gulberg'),
      discoveryClaimedAt: null,
    });
  });
});

// Proves the daily cap stops a run that could pass it, on the Asia/Karachi day (FR-33, Q6).
describe('discoverCampaign: the Apify daily cap', () => {
  it('pauses before starting when spend plus the charge limit would pass the cap', async () => {
    await spendEarlier('1.40', new Date());
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(0);
    expect((await campaignRow(claim.id)).pauseReason).toBe(
      'Apify daily cap: $1.40 spent today, the next run may charge up to $0.61, the cap is $2.00',
    );
  });

  it('allows a run that could land exactly on the cap', async () => {
    await spendEarlier('1.39', new Date());
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), await newCampaign());

    expect(leadSource.starts.length).toBeGreaterThan(0);
  });

  it('does not count spend from before midnight in Karachi', async () => {
    const lastMomentYesterday = new Date(karachiDayStart(new Date()).getTime() - 1);
    await spendEarlier('5.00', lastMomentYesterday);

    await expect(discoverCampaign(deps(new SpyLeadSource()), await newCampaign())).resolves.toBe(
      'ENRICHING',
    );
  });

  it('counts spend from the first moment of the Karachi day', async () => {
    await spendEarlier('5.00', karachiDayStart(new Date()));

    await expect(discoverCampaign(deps(new SpyLeadSource()), await newCampaign())).resolves.toBe(
      'PAUSED',
    );
  });

  it('lets a lower cap per search use a lower limit', async () => {
    await spendEarlier('1.45', new Date());
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();
    await prisma.campaign.update({ where: { id: claim.id }, data: { maxResultsPerSearch: 30 } });

    await discoverCampaign(deps(leadSource), claim);

    expect(leadSource.starts[0]?.chargeLimitUsd.toFixed(2)).toBe('0.50');
  });
});

// Proves discover can stop anywhere and finish later with the same counts and no extra paid run.
describe('discoverCampaign: stopping and carrying on', () => {
  const expected = { status: 'ENRICHING', foundCount: 12, duplicateCount: 1, filteredCount: 2 };

  it('after a cap pause, runs only the searches left', async () => {
    // $0.61 fits, but $0.072 spent plus the next $0.61 does not.
    await setApifyCap('0.62');
    const first = new SpyLeadSource();
    const claim = await newCampaign();
    await expect(discoverCampaign(deps(first), claim)).resolves.toBe('PAUSED');
    expect(first.starts).toHaveLength(1);

    await setApifyCap('2.00');
    const second = new SpyLeadSource();
    await discoverCampaign(deps(second), await resume(claim.id));

    expect(second.starts.map((search) => search.term)).toEqual([
      'dentist',
      'dental surgeon',
      'orthodontist',
    ]);
    expect(await campaignRow(claim.id)).toMatchObject(expected);
    expect(await costs(claim.id)).toHaveLength(4);
  });

  it('reattaches to a run saved before a crash, instead of paying again', async () => {
    const claim = await newCampaign();
    const runId = JSON.stringify({ term: 'dental clinic', area: 'DHA', maxResults: 100 });
    await repository.reserveSearch({
      organizationId,
      campaignId: claim.id,
      amountUsd: new Prisma.Decimal('0.61'),
      note: searchNote({ term: 'dental clinic', area: 'DHA', runId }),
    });
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), claim);

    expect(leadSource.starts.map((search) => search.term)).not.toContain('dental clinic');
    expect(leadSource.collects).toContain(runId);
    expect(await campaignRow(claim.id)).toMatchObject(expected);
    const reattached = (await costs(claim.id)).find((record) => record.units === 12);
    expect(reattached?.amountUsd.toFixed(3)).toBe('0.072');
  });

  it('counts an unfinished run at its limit against the cap', async () => {
    const earlier = await newCampaign();
    await repository.reserveSearch({
      organizationId,
      campaignId: earlier.id,
      amountUsd: new Prisma.Decimal('1.50'),
      note: searchNote({ term: 'dental clinic', area: 'DHA', runId: 'fictional' }),
    });
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), await newCampaign());

    expect(leadSource.starts).toHaveLength(0);
  });

  it('after a failed read, pauses and reads the same run again on resume', async () => {
    const leadSource = new SpyLeadSource({
      onCollect: (collectNumber) => {
        if (collectNumber === 1) throw new Error('fictional network failure');
      },
    });
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');
    expect((await campaignRow(claim.id)).pauseReason).toContain('without paying');
    await discoverCampaign(deps(leadSource), await resume(claim.id));

    expect(leadSource.starts).toHaveLength(4);
    expect(leadSource.collects[0]).toBe(leadSource.collects[1]);
    expect(await campaignRow(claim.id)).toMatchObject(expected);
  });

  it('after a failed start, pauses and tells the founder to check for a run', async () => {
    const leadSource = new SpyLeadSource({
      onStart: (startNumber) =>
        startNumber === 2 ? Promise.reject(new Error('fictional 503')) : Promise.resolve(),
    });
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(2);
    expect((await campaignRow(claim.id)).pauseReason).toContain('check the Apify console');
    expect(await costs(claim.id)).toHaveLength(1);
  });

  it('stops without another start when an operator pauses it mid-run', async () => {
    const claim = await newCampaign();
    const leadSource = new SpyLeadSource({
      onStart: async (startNumber) => {
        if (startNumber !== 2) return;
        await prisma.campaign.update({
          where: { id: claim.id },
          data: { status: 'PAUSED', pausedFrom: 'DISCOVERING' },
        });
      },
    });

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('STOPPED');

    expect(leadSource.starts).toHaveLength(2);
    expect(await campaignRow(claim.id)).toMatchObject({ status: 'PAUSED', pauseReason: null });
  });

  it('changes nothing when run again after every search is stored', async () => {
    const claim = await newCampaign();
    await discoverCampaign(deps(new SpyLeadSource()), claim);
    const again = new SpyLeadSource();

    await discoverCampaign(deps(again), await resume(claim.id));

    expect(again.starts).toHaveLength(0);
    expect(again.collects).toHaveLength(0);
    expect(await campaignRow(claim.id)).toMatchObject(expected);
    expect(await prisma.lead.count()).toBe(11);
  });
});
