/**
 * Integration test of the discover step on real Postgres with the fake lead source.
 *
 * Serves: FR-5 to FR-8, FR-33, NFR-1, NFR-2; issue #10 acceptance criteria.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import type { CompassPlaceItem } from '../src/adapters/lead-source/apify-items.js';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { DiscoveryRepository, type Claim } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { createLogger } from '../src/logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from '../src/pipeline/area-polygons.js';
import { discoverCampaign, type DiscoverDeps } from '../src/pipeline/discover.step.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { readSearchNote, searchNote } from '../src/pipeline/search-plan.js';
import { karachiDayStart } from '../src/pipeline/spend-cap.js';
import type { CollectedRun, LeadSourcePort, PlaceSearch } from '../src/ports/lead-source.port.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const logger = createLogger('error');
const organizationId = SEED_ORGANIZATION_ID;
const polygons = loadAreaPolygons(AREAS_DIR);
// A fixed clock: the cap counts this Asia/Karachi day, whatever time the tests really run.
const NOW = new Date('2026-11-05T07:00:00.000Z');

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
      onCollect?: (collectNumber: number) => Promise<void>;
      runFor?: (term: string, run: CollectedRun) => Partial<CollectedRun>;
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
    await this.hooks.onCollect?.(this.collects.length);
    const run = await this.fake.collect(runId);
    const term = (JSON.parse(runId) as { term: string }).term;
    return { ...run, ...this.hooks.runFor?.(term, run) };
  }
}

const deps = (leadSource: LeadSourcePort, repo = repository): DiscoverDeps => ({
  repository: repo,
  leadSource,
  polygons,
  logger,
  now: () => NOW,
  startGate: new PaidStartGate(),
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

// What a second runner does once a lease has run out.
const takeOver = async (id: string, at: Date): Promise<Claim> => {
  await prisma.campaign.update({ where: { id }, data: { discoveryClaimedAt: at } });
  return { id, claimedAt: at };
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

// A search's record as an earlier pass left it; a null run id is what a crash leaves.
const reservedSearch = (campaignId: string, amountUsd: string, runId: string | null) =>
  prisma.costRecord.create({
    data: {
      organizationId,
      campaignId,
      service: 'APIFY',
      amountUsd,
      at: NOW,
      note: searchNote({ term: 'dental clinic', area: 'DHA', runId }),
    },
  });

const spentToday = () => repository.apifySpentSince(organizationId, karachiDayStart(NOW));
const notes = async (campaignId: string) =>
  (await costs(campaignId)).map(({ note, amountUsd }) => ({
    ...readSearchNote(note),
    amountUsd: amountUsd.toFixed(2),
  }));

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
    expect(records.map((record) => record.units)).toEqual([3, 3, 3, 3]);
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

// Proves the one exception to FR-7: a place closed for a while can still become a lead.
describe('discoverCampaign: a temporarily closed place that reopens', () => {
  const placeId = 'fictional-place-p09';
  const withPlace = (change: Partial<CompassPlaceItem>) =>
    new SpyLeadSource({
      runFor: (_term, run) => ({
        items: run.items.map((item) => (item.placeId === placeId ? { ...item, ...change } : item)),
      }),
    });

  const closedInFirstCampaign = async (): Promise<Claim> => {
    const first = await newCampaign();
    await discoverCampaign(deps(withPlace({ temporarilyClosed: true })), first);
    expect(await lead(placeId)).toMatchObject({
      status: 'FILTERED_OUT',
      filterReason: 'temporarily closed',
    });
    return first;
  };

  it('becomes a lead of the campaign that saw it open, with the counts to match', async () => {
    const first = await closedInFirstCampaign();
    const second = await newCampaign();

    await discoverCampaign(deps(new SpyLeadSource()), second);

    expect(await lead(placeId)).toMatchObject({
      campaignId: second.id,
      status: 'DISCOVERED',
      filterReason: null,
      rawPlace: { temporarilyClosed: false },
    });
    expect(await campaignRow(second.id)).toMatchObject({
      status: 'ENRICHING',
      foundCount: 12,
      duplicateCount: 11,
      filteredCount: 0,
    });
    expect(await campaignRow(first.id)).toMatchObject({
      foundCount: 12,
      duplicateCount: 1,
      filteredCount: 3,
    });
  });

  it('is filtered again, so it can fail another rule this time', async () => {
    await closedInFirstCampaign();
    const second = await newCampaign();

    await discoverCampaign(deps(withPlace({ totalScore: 3.1 })), second);

    expect(await lead(placeId)).toMatchObject({
      campaignId: second.id,
      status: 'FILTERED_OUT',
      filterReason: 'rating 3.1 is below the minimum 4',
    });
    expect(await campaignRow(second.id)).toMatchObject({ duplicateCount: 11, filteredCount: 1 });
  });

  it('stays a plain duplicate while it is still closed', async () => {
    const first = await closedInFirstCampaign();
    const second = await newCampaign();

    await discoverCampaign(deps(withPlace({ temporarilyClosed: true })), second);

    expect(await lead(placeId)).toMatchObject({ campaignId: first.id, status: 'FILTERED_OUT' });
    expect(await campaignRow(second.id)).toMatchObject({ duplicateCount: 12, filteredCount: 0 });
  });

  it('stays a plain duplicate when it has closed for good', async () => {
    const first = await closedInFirstCampaign();
    const second = await newCampaign();

    await discoverCampaign(deps(withPlace({ permanentlyClosed: true })), second);

    expect(await lead(placeId)).toMatchObject({
      campaignId: first.id,
      filterReason: 'temporarily closed',
    });
    expect(await campaignRow(second.id)).toMatchObject({ duplicateCount: 12 });
  });

  it('leaves a place filtered for any other reason as a plain duplicate', async () => {
    const first = await newCampaign();
    await discoverCampaign(deps(new SpyLeadSource()), first);
    const second = await newCampaign();

    await discoverCampaign(deps(new SpyLeadSource()), second);

    expect(await lead('fictional-place-p05')).toMatchObject({
      campaignId: first.id,
      status: 'FILTERED_OUT',
      filterReason: 'rating 3.6 is below the minimum 4',
    });
    expect(await campaignRow(second.id)).toMatchObject({ duplicateCount: 12, filteredCount: 0 });
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
    const runFor = (term: string): Partial<CollectedRun> => {
      if (term === 'dental clinic') return { items: [branch('branch-1'), branch('branch-2')] };
      return { items: [branch(term === 'dentist' ? 'branch-3' : 'branch-1')] };
    };
    const claim = await newCampaign();

    await discoverCampaign(deps(new SpyLeadSource({ runFor })), claim);

    expect(await campaignRow(claim.id)).toMatchObject({ foundCount: 5, filteredCount: 3 });
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
    const claim = await newCampaign(['DHA', 'Cantt']);

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(0);
    expect(await costs(claim.id)).toHaveLength(0);
    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'DISCOVERING',
      pauseReason: expect.stringContaining('Cantt'),
      discoveryClaimedAt: null,
    });
  });
});

// Proves the daily cap stops a run that could pass it, on the Asia/Karachi day (FR-33, Q6).
describe('discoverCampaign: the Apify daily cap', () => {
  it('pauses before starting when spend plus the charge limit would pass the cap', async () => {
    await spendEarlier('1.40', NOW);
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(0);
    expect((await campaignRow(claim.id)).pauseReason).toBe(
      'Apify daily cap: $1.40 spent today, the next run may charge up to $0.61, the cap is $2.00',
    );
  });

  it('allows a run that could land exactly on the cap', async () => {
    await spendEarlier('1.39', NOW);
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), await newCampaign());

    expect(leadSource.starts.length).toBeGreaterThan(0);
  });

  it('does not count spend from before midnight in Karachi', async () => {
    const lastMomentYesterday = new Date(karachiDayStart(NOW).getTime() - 1);
    await spendEarlier('5.00', lastMomentYesterday);

    await expect(discoverCampaign(deps(new SpyLeadSource()), await newCampaign())).resolves.toBe(
      'ENRICHING',
    );
  });

  it('counts spend from the first moment of the Karachi day', async () => {
    await spendEarlier('5.00', karachiDayStart(NOW));

    await expect(discoverCampaign(deps(new SpyLeadSource()), await newCampaign())).resolves.toBe(
      'PAUSED',
    );
  });

  it('lets a lower cap per search use a lower limit', async () => {
    await spendEarlier('1.45', NOW);
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();
    await prisma.campaign.update({ where: { id: claim.id }, data: { maxResultsPerSearch: 30 } });

    await discoverCampaign(deps(leadSource), claim);

    expect(leadSource.starts[0]?.chargeLimitUsd.toFixed(2)).toBe('0.50');
  });
});

// Proves the review's first blocker: a run with no saved id is never paid for again on its own.
describe('discoverCampaign: a record with no run id', () => {
  const finished = { status: 'ENRICHING', foundCount: 12, duplicateCount: 1, filteredCount: 2 };
  const dentalStarts = (leadSource: SpyLeadSource) =>
    leadSource.starts.filter((search) => search.term === 'dental clinic');

  it('pauses and starts nothing, keeping the reservation', async () => {
    const claim = await newCampaign();
    await reservedSearch(claim.id, '0.61', null);
    const leadSource = new SpyLeadSource();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(0);
    expect((await campaignRow(claim.id)).pauseReason).toContain('Check the Apify console first');
    expect(await notes(claim.id)).toEqual([
      expect.objectContaining({ runId: null, state: 'CHECK_APIFY', amountUsd: '0.61' }),
    ]);
  });

  it('on resume, abandons it, keeps its amount and starts under a new reservation', async () => {
    const claim = await newCampaign();
    await reservedSearch(claim.id, '0.61', null);
    await discoverCampaign(deps(new SpyLeadSource()), claim);
    const resumed = new SpyLeadSource();

    await expect(discoverCampaign(deps(resumed), await resume(claim.id))).resolves.toBe(
      'ENRICHING',
    );

    expect(dentalStarts(resumed)).toHaveLength(1);
    expect(await campaignRow(claim.id)).toMatchObject(finished);
    expect(await notes(claim.id)).toContainEqual(
      expect.objectContaining({ state: 'ABANDONED', amountUsd: '0.61' }),
    );
    expect(await costs(claim.id)).toHaveLength(5);
    expect((await spentToday()).toFixed(3)).toBe('0.682');
  });

  it('on resume, still obeys the cap, with the abandoned amount counted', async () => {
    await setApifyCap('1.00');
    const claim = await newCampaign();
    await reservedSearch(claim.id, '0.61', null);
    await discoverCampaign(deps(new SpyLeadSource()), claim);
    const resumed = new SpyLeadSource();

    await expect(discoverCampaign(deps(resumed), await resume(claim.id))).resolves.toBe('PAUSED');

    expect(resumed.starts).toHaveLength(0);
    expect((await campaignRow(claim.id)).pauseReason).toContain('$0.61 spent today');
  });

  it('pauses over a failed run-id save, naming the run, and starts nothing more', async () => {
    class FailsSave extends DiscoveryRepository {
      override saveRunId(): Promise<void> {
        return Promise.reject(new Error('fictional database error'));
      }
    }
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource, new FailsSave(prisma)), claim)).resolves.toBe(
      'PAUSED',
    );

    expect(dentalStarts(leadSource)).toHaveLength(1);
    expect(leadSource.collects).toHaveLength(0);
    expect((await campaignRow(claim.id)).pauseReason).toContain('its id could not be saved');
    expect(await notes(claim.id)).toEqual([
      expect.objectContaining({ runId: null, state: 'CHECK_APIFY', amountUsd: '0.61' }),
    ]);
  });

  it('pays once after a database outage right after Apify accepted the start', async () => {
    class Outage extends DiscoveryRepository {
      override saveRunId(): Promise<void> {
        return Promise.reject(new Error('fictional outage'));
      }
      override pauseForCheck(): Promise<boolean> {
        return Promise.reject(new Error('fictional outage'));
      }
      override pause(): Promise<boolean> {
        return Promise.reject(new Error('fictional outage'));
      }
    }
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();
    await discoverCampaign(deps(leadSource, new Outage(prisma)), claim).catch(() => null);

    const restart = await takeOver(claim.id, new Date(NOW.getTime() + 1));
    await expect(discoverCampaign(deps(leadSource), restart)).resolves.toBe('PAUSED');

    expect(dentalStarts(leadSource)).toHaveLength(1);
    expect((await spentToday()).toFixed(2)).toBe('0.61');
  });
});

// Proves a paid run that went wrong keeps what it returned, pauses, and is never re-run by itself.
describe('discoverCampaign: a run that went wrong', () => {
  const partial = (status: CollectedRun['status']) => (term: string) =>
    term === 'dentist' ? { status } : {};

  it.each(['FAILED', 'TIMED-OUT'] as const)('keeps a %s run and pauses', async (status) => {
    const leadSource = new SpyLeadSource({ runFor: partial(status) });
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(2);
    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'DISCOVERING',
      pauseReason: expect.stringContaining(`ended as ${status}`),
      foundCount: 6,
      discoveryClaimedAt: null,
    });
    expect(await prisma.lead.count({ where: { campaignId: claim.id } })).toBe(6);
  });

  it('does not re-run that search on resume, and moves on to the next', async () => {
    const claim = await newCampaign();
    await discoverCampaign(deps(new SpyLeadSource({ runFor: partial('FAILED') })), claim);
    const resumed = new SpyLeadSource();

    await expect(discoverCampaign(deps(resumed), await resume(claim.id))).resolves.toBe(
      'ENRICHING',
    );

    expect(resumed.starts.map((search) => search.term)).toEqual(['dental surgeon', 'orthodontist']);
    expect(await costs(claim.id)).toHaveLength(4);
  });

  it('pauses when every item was invalid, and stores none', async () => {
    const runFor = (term: string) =>
      term === 'dental clinic' ? { items: [], skippedCount: 3 } : {};
    const leadSource = new SpyLeadSource({ runFor });
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(1);
    expect((await campaignRow(claim.id)).pauseReason).toContain("Compass's fields");
    expect(await notes(claim.id)).toEqual([expect.objectContaining({ amountUsd: '0.02' })]);
  });

  it('pauses when a successful run found nothing, then needs no second pause', async () => {
    const runFor = (term: string) => (term === 'dentist' ? { items: [] } : {});
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(new SpyLeadSource({ runFor })), claim)).resolves.toBe(
      'PAUSED',
    );

    expect((await campaignRow(claim.id)).pauseReason).toContain('found no places');
    await expect(discoverCampaign(deps(new SpyLeadSource()), await resume(claim.id))).resolves.toBe(
      'ENRICHING',
    );
  });

  it('stops without pausing for a worker that lost its claim, keeping the results', async () => {
    const claim = await newCampaign();
    const leadSource = new SpyLeadSource({
      onCollect: async () => {
        await takeOver(claim.id, new Date(NOW.getTime() + 1));
      },
      runFor: () => ({ status: 'FAILED' }),
    });

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('STOPPED');

    expect(await campaignRow(claim.id)).toMatchObject({ status: 'DISCOVERING', foundCount: 3 });
  });
});

// Proves a run that went wrong reaches the founder before more is paid, whoever gets to store it.
describe('discoverCampaign: a failed run racing a pause or a second worker', () => {
  const failed = () => ({ status: 'FAILED' as const });
  const pausedCalls = (warn: { mock: { calls: unknown[][] } }) =>
    warn.mock.calls.filter(([, message]) => message === 'campaign paused');

  it('shows the reason on an operator pause, and pays nothing more on resume', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const claim = await newCampaign();
    const leadSource = new SpyLeadSource({
      onCollect: async () => {
        await prisma.campaign.update({
          where: { id: claim.id },
          data: { status: 'PAUSED', pausedFrom: 'DISCOVERING' },
        });
      },
      runFor: failed,
    });

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('STOPPED');

    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'PAUSED',
      pauseReason: expect.stringContaining('ended as FAILED'),
    });
    expect(pausedCalls(warn)).toHaveLength(0);

    const resumed = new SpyLeadSource({ runFor: failed });
    await expect(discoverCampaign(deps(resumed), await resume(claim.id))).resolves.toBe('PAUSED');

    expect(resumed.starts).toHaveLength(0);
    expect(resumed.collects).toEqual(leadSource.collects);
    expect(await campaignRow(claim.id)).toMatchObject({
      pauseReason: expect.stringContaining('ended as FAILED'),
      foundCount: 3,
    });
    expect(pausedCalls(warn)).toHaveLength(1);
    warn.mockRestore();
  });

  it('pauses under the real holder when a stale worker stored the failed run first', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const claim = await newCampaign();
    let holderIsReading = (): void => undefined;
    const reading = new Promise<void>((resolve) => {
      holderIsReading = resolve;
    });
    const stale = new SpyLeadSource({ onCollect: () => reading, runFor: failed });
    const stalePass = discoverCampaign(deps(stale), claim);
    while (stale.collects.length === 0) await sleep(5);
    const later = new Date(NOW.getTime() + 1);
    const taken = await takeOver(claim.id, later);
    const holder = new SpyLeadSource({
      onCollect: async () => {
        holderIsReading();
        await stalePass;
      },
      runFor: failed,
    });

    // Its own clock: renewing at NOW would hand the stale worker its lease value back.
    await expect(discoverCampaign({ ...deps(holder), now: () => later }, taken)).resolves.toBe(
      'PAUSED',
    );

    await expect(stalePass).resolves.toBe('STOPPED');
    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'PAUSED',
      pauseReason: expect.stringContaining('ended as FAILED'),
      foundCount: 3,
      discoveryClaimedAt: null,
    });
    expect(holder.starts).toHaveLength(0);
    expect(pausedCalls(warn)).toHaveLength(1);
    warn.mockRestore();
  });

  it('stores nothing from a stale start into an abandoned record, keeping its run id', async () => {
    const warn = jest.spyOn(logger, 'warn');
    const claim = await newCampaign();
    let finishStart = (): void => undefined;
    const stuck = new Promise<void>((resolve) => {
      finishStart = resolve;
    });
    const stale = new SpyLeadSource({
      onStart: (startNumber) => (startNumber === 1 ? stuck : Promise.resolve()),
    });
    const stalePass = discoverCampaign(deps(stale), claim);
    while (stale.starts.length === 0) await sleep(5);
    const taken = await takeOver(claim.id, new Date(NOW.getTime() + 1));
    await expect(discoverCampaign(deps(new SpyLeadSource()), taken)).resolves.toBe('PAUSED');
    await expect(discoverCampaign(deps(new SpyLeadSource()), await resume(claim.id))).resolves.toBe(
      'ENRICHING',
    );

    finishStart();

    await expect(stalePass).resolves.toBe('STOPPED');
    expect(await campaignRow(claim.id)).toMatchObject({
      status: 'ENRICHING',
      foundCount: 12,
      duplicateCount: 1,
    });
    const abandoned = (await notes(claim.id)).find(({ state }) => state === 'ABANDONED');
    expect(abandoned).toMatchObject({ amountUsd: '0.61', runId: expect.any(String) });
    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ runId: abandoned?.runId }),
      expect.stringContaining('not stored'),
    );
    warn.mockRestore();
  });
});

// Proves the review's second blocker: the cap check and reservation cannot be raced past (FR-33).
describe('discoverCampaign: two runners and one cap', () => {
  it('lets one of two staggered campaigns start under a one-run cap', async () => {
    await setApifyCap('0.61');
    const leadSource = new SpyLeadSource({ onStart: () => sleep(100) });
    const [first, second] = [await newCampaign(), await newCampaign()];

    const results = await Promise.all([
      discoverCampaign(deps(leadSource), first),
      sleep(20).then(() => discoverCampaign(deps(leadSource), second)),
    ]);

    expect(leadSource.starts).toHaveLength(1);
    expect(results.filter((result) => result === 'PAUSED')).toHaveLength(2);
  });

  it('holds no lock or transaction during the Apify request', async () => {
    const other = await newCampaign();
    const claim = await newCampaign();
    const reservations: string[] = [];
    const leadSource = new SpyLeadSource({
      onStart: async (startNumber) => {
        if (startNumber !== 1) return;
        const reservation = await repository.reserveWithinCap(other, {
          organizationId,
          amountUsd: new Prisma.Decimal('0.61'),
          capUsd: new Prisma.Decimal('2.00'),
          dayStart: karachiDayStart(NOW),
          at: NOW,
          note: 'fictional note',
        });
        reservations.push(reservation.outcome);
      },
    });

    await discoverCampaign(deps(leadSource), claim);

    expect(reservations).toEqual(['RESERVED']);
  });
});

// Proves a second worker taking over after a lease expires can neither pay again nor double-count.
describe('discoverCampaign: two workers after a lease expires', () => {
  const finished = { status: 'ENRICHING', foundCount: 12, duplicateCount: 1, filteredCount: 2 };

  it('pauses the second worker while the first is inside its start, and pays once', async () => {
    const claim = await newCampaign();
    const second = new SpyLeadSource();
    const results: string[] = [];
    const first = new SpyLeadSource({
      onStart: async (startNumber) => {
        if (startNumber !== 1) return;
        const taken = await takeOver(claim.id, new Date(NOW.getTime() + 1));
        results.push(await discoverCampaign(deps(second), taken));
      },
    });

    await expect(discoverCampaign(deps(first), claim)).resolves.toBe('STOPPED');

    expect(results).toEqual(['PAUSED']);
    expect(first.starts).toHaveLength(1);
    expect(second.starts).toHaveLength(0);

    const resumed = new SpyLeadSource();
    await discoverCampaign(deps(resumed), await resume(claim.id));

    expect(resumed.starts.map((search) => search.term)).not.toContain('dental clinic');
    expect(await campaignRow(claim.id)).toMatchObject(finished);
  });

  it('stores a run once when both workers collect it', async () => {
    const claim = await newCampaign();
    const second = new SpyLeadSource();
    const first = new SpyLeadSource({
      onCollect: async (collectNumber) => {
        if (collectNumber !== 1) return;
        await discoverCampaign(deps(second), await takeOver(claim.id, new Date(NOW.getTime() + 1)));
      },
    });

    await expect(discoverCampaign(deps(first), claim)).resolves.toBe('STOPPED');

    expect(first.starts).toHaveLength(1);
    expect(second.starts.map((search) => search.term)).not.toContain('dental clinic');
    expect(await campaignRow(claim.id)).toMatchObject(finished);
    expect(await costs(claim.id)).toHaveLength(4);
  });
});

// Proves discover can stop anywhere and finish later with the same counts and no extra paid run.
describe('discoverCampaign: stopping and carrying on', () => {
  const expected = { status: 'ENRICHING', foundCount: 12, duplicateCount: 1, filteredCount: 2 };

  it('after a cap pause, runs only the searches left', async () => {
    // $0.61 fits, but $0.018 spent plus the next $0.61 does not.
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
    await reservedSearch(claim.id, '0.61', runId);
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), claim);

    expect(leadSource.starts.map((search) => search.term)).not.toContain('dental clinic');
    expect(leadSource.collects).toContain(runId);
    expect(await campaignRow(claim.id)).toMatchObject(expected);
    const reattached = (await costs(claim.id)).find((record) => record.note?.includes('clinic'));
    expect(reattached?.amountUsd.toFixed(3)).toBe('0.018');
  });

  it('counts an unfinished run at its limit against the cap', async () => {
    const earlier = await newCampaign();
    await reservedSearch(earlier.id, '1.50', 'fictional');
    const leadSource = new SpyLeadSource();

    await discoverCampaign(deps(leadSource), await newCampaign());

    expect(leadSource.starts).toHaveLength(0);
  });

  it('after a failed read, pauses and reads the same run again on resume', async () => {
    const leadSource = new SpyLeadSource({
      onCollect: (collectNumber) =>
        collectNumber === 1
          ? Promise.reject(new Error('fictional network failure'))
          : Promise.resolve(),
    });
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');
    expect((await campaignRow(claim.id)).pauseReason).toContain('without paying');
    await discoverCampaign(deps(leadSource), await resume(claim.id));

    expect(leadSource.starts).toHaveLength(4);
    expect(leadSource.collects[0]).toBe(leadSource.collects[1]);
    expect(await campaignRow(claim.id)).toMatchObject(expected);
  });

  it('after a failed start, pauses, keeps the reservation and asks for a check', async () => {
    const leadSource = new SpyLeadSource({
      onStart: (startNumber) =>
        startNumber === 2 ? Promise.reject(new Error('fictional 503')) : Promise.resolve(),
    });
    const claim = await newCampaign();

    await expect(discoverCampaign(deps(leadSource), claim)).resolves.toBe('PAUSED');

    expect(leadSource.starts).toHaveLength(2);
    expect((await campaignRow(claim.id)).pauseReason).toContain('Check the Apify console first');
    expect(await notes(claim.id)).toContainEqual(
      expect.objectContaining({
        term: 'dentist',
        runId: null,
        state: 'CHECK_APIFY',
        amountUsd: '0.61',
      }),
    );
    expect((await spentToday()).toFixed(3)).toBe('0.628');
  });

  it('resuming after a failed start abandons that record and pays under a new one', async () => {
    const failing = new SpyLeadSource({
      onStart: (startNumber) =>
        startNumber === 1 ? Promise.reject(new Error('fictional 503')) : Promise.resolve(),
    });
    const claim = await newCampaign();
    await discoverCampaign(deps(failing), claim);

    await discoverCampaign(deps(new SpyLeadSource()), await resume(claim.id));

    expect(await campaignRow(claim.id)).toMatchObject(expected);
    expect(await notes(claim.id)).toContainEqual(
      expect.objectContaining({ runId: null, state: 'ABANDONED', amountUsd: '0.61' }),
    );
    expect((await spentToday()).toFixed(3)).toBe('0.682');
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

  it('stops without a start when the claim is lost before the reservation', async () => {
    const claim = await newCampaign();
    class LosesClaim extends DiscoveryRepository {
      override async reserveWithinCap(
        ...args: Parameters<DiscoveryRepository['reserveWithinCap']>
      ) {
        await prisma.campaign.update({
          where: { id: claim.id },
          data: { discoveryClaimedAt: new Date(NOW.getTime() + 1) },
        });
        return super.reserveWithinCap(...args);
      }
    }
    const leadSource = new SpyLeadSource();

    await expect(discoverCampaign(deps(leadSource, new LosesClaim(prisma)), claim)).resolves.toBe(
      'STOPPED',
    );

    expect(leadSource.starts).toHaveLength(0);
    expect(await costs(claim.id)).toHaveLength(0);
  });

  it('reserves nothing and releases its claim once shutdown has begun', async () => {
    const startGate = new PaidStartGate();
    await startGate.close(0);
    const leadSource = new SpyLeadSource();
    const claim = await newCampaign();

    await expect(discoverCampaign({ ...deps(leadSource), startGate }, claim)).resolves.toBe(
      'STOPPED',
    );

    expect(leadSource.starts).toHaveLength(0);
    expect(await costs(claim.id)).toHaveLength(0);
    expect((await campaignRow(claim.id)).discoveryClaimedAt).toBeNull();
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
