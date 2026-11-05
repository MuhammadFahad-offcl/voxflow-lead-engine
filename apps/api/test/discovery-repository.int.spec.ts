/**
 * Integration test of the discovery repository's guards on real Postgres.
 *
 * Serves: FR-3, FR-7, FR-33, NFR-1, NFR-2; issue #10 (founder decisions on Q2 and Q3).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { DiscoveryRepository, type Claim } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { readSearchNote, searchNote } from '../src/pipeline/search-plan.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;
let repository: DiscoveryRepository;
let organizationId: string;
let nicheProfileId: string;

const newClaim = async (): Promise<Claim> => {
  const claimedAt = new Date('2026-11-05T07:00:00.000Z');
  const { id } = await prisma.campaign.create({
    data: {
      organizationId,
      nicheProfileId,
      city: 'Lahore',
      areas: ['DHA'],
      discoveryClaimedAt: claimedAt,
    },
  });
  return { id, claimedAt };
};

const reserve = async (campaignId: string, amountUsd = '0.61'): Promise<string> => {
  const { id } = await prisma.costRecord.create({
    data: { organizationId, campaignId, service: 'APIFY', amountUsd, note: 'fictional note' },
  });
  return id;
};

const row = (campaignId: string, placeId: string): Prisma.LeadCreateManyInput => ({
  organizationId,
  campaignId,
  placeId,
  name: `Fictional ${placeId}`,
  rawPlace: {},
});

const campaign = (id: string) => prisma.campaign.findUniqueOrThrow({ where: { id } });
const later = new Date('2026-11-05T07:05:00.000Z');
const dayStart = new Date('2026-11-04T19:00:00.000Z');
const reservedNote = searchNote({ term: 'fictional term', area: 'DHA', runId: null });

const reserveUnder = (claim: Claim, capUsd: string) =>
  repository.reserveWithinCap(claim, {
    organizationId,
    amountUsd: new Prisma.Decimal('0.61'),
    capUsd: new Prisma.Decimal(capUsd),
    dayStart,
    at: later,
    note: reservedNote,
  });

const recordNote = async (id: string) => {
  const record = await prisma.costRecord.findUniqueOrThrow({ where: { id } });
  return { amountUsd: record.amountUsd.toFixed(2), note: readSearchNote(record.note) };
};

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_discovery_repository_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  repository = new DiscoveryRepository(prisma);
  ({ id: organizationId } = await prisma.organization.create({ data: { name: 'Fictional Org' } }));
  ({ id: nicheProfileId } = await prisma.nicheProfile.create({
    data: {
      organizationId,
      slug: 'fictional',
      version: 1,
      name: 'Fictional niche',
      searchTerms: ['fictional term'],
      idealClient: {},
      signalWeights: {},
      scriptTemplate: 'Fictional template',
    },
  }));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.costRecord.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.campaign.deleteMany();
});

// Proves only the holder of a live claim can go on: the check before every paid start.
describe('renewClaim', () => {
  it('moves the lease forward for the holder', async () => {
    const claim = await newClaim();

    await expect(repository.renewClaim(claim, later)).resolves.toEqual({
      id: claim.id,
      claimedAt: later,
    });
    expect((await campaign(claim.id)).discoveryClaimedAt).toEqual(later);
  });

  it('fails for a runner whose lease another runner took over', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await expect(repository.renewClaim(claim, new Date())).resolves.toBeNull();
  });

  it('fails once an operator has paused the campaign', async () => {
    const claim = await newClaim();
    await prisma.campaign.update({
      where: { id: claim.id },
      data: { status: 'PAUSED', pausedFrom: 'DISCOVERING' },
    });

    await expect(repository.renewClaim(claim, later)).resolves.toBeNull();
  });
});

// Proves a stale runner cannot clear or pause what it no longer holds.
describe('releaseClaim and pause', () => {
  it('clears the holder own claim', async () => {
    const claim = await newClaim();

    await repository.releaseClaim(claim);

    expect((await campaign(claim.id)).discoveryClaimedAt).toBeNull();
  });

  it('leaves a newer claim alone', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await repository.releaseClaim(claim);

    expect((await campaign(claim.id)).discoveryClaimedAt).toEqual(later);
  });

  it('pauses with the reason, remembering where to resume', async () => {
    const claim = await newClaim();

    await expect(repository.pause(claim, 'Fictional reason')).resolves.toBe(true);

    expect(await campaign(claim.id)).toMatchObject({
      status: 'PAUSED',
      pausedFrom: 'DISCOVERING',
      pauseReason: 'Fictional reason',
      discoveryClaimedAt: null,
    });
  });

  it('does not pause for a stale runner', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await expect(repository.pause(claim, 'Fictional reason')).resolves.toBe(false);

    expect(await campaign(claim.id)).toMatchObject({ status: 'DISCOVERING', pauseReason: null });
  });
});

// Proves the daily total: reservations count, other services and earlier days do not.
describe('apifySpentSince', () => {
  it('adds Apify records from the moment given, in Decimal', async () => {
    const since = new Date('2026-11-04T19:00:00.000Z');
    const record = (service: 'APIFY' | 'LLM', amountUsd: string, at: Date) =>
      prisma.costRecord.create({ data: { organizationId, service, amountUsd, at } });
    await record('APIFY', '0.10000', since);
    await record('APIFY', '0.20000', later);
    await record('LLM', '5.00000', later);
    await record('APIFY', '7.00000', new Date(since.getTime() - 1));

    const spent = await repository.apifySpentSince(organizationId, since);

    expect(spent.toFixed(2)).toBe('0.30');
  });

  it('is 0 with no records', async () => {
    const spent = await repository.apifySpentSince(organizationId, later);

    expect(spent.isZero()).toBe(true);
  });
});

// Proves the cap check and the reservation are one step, so no two runners can both fit (FR-33).
describe('reserveWithinCap', () => {
  it('saves the limit against the campaign, with no run id yet', async () => {
    const claim = await newClaim();

    const reserved = await reserveUnder(claim, '2.00');

    if (reserved.outcome !== 'RESERVED') throw new Error('Expected a reservation');
    expect(await recordNote(reserved.recordId)).toMatchObject({
      amountUsd: '0.61',
      note: { runId: null, state: 'OPEN' },
    });
  });

  it('allows landing exactly on the cap and refuses a cent past it', async () => {
    const claim = await newClaim();

    await expect(reserveUnder(claim, '0.61')).resolves.toMatchObject({ outcome: 'RESERVED' });
    const refused = await reserveUnder(claim, '1.21');

    expect(refused).toMatchObject({ outcome: 'OVER_CAP' });
    expect(refused.outcome === 'OVER_CAP' && refused.spent.toFixed(2)).toBe('0.61');
    expect(await prisma.costRecord.count()).toBe(1);
  });

  it('does not count a record from before the day began', async () => {
    const claim = await newClaim();
    await prisma.costRecord.create({
      data: {
        organizationId,
        service: 'APIFY',
        amountUsd: '5.00',
        at: new Date(dayStart.getTime() - 1),
      },
    });

    await expect(reserveUnder(claim, '0.61')).resolves.toMatchObject({ outcome: 'RESERVED' });
  });

  it('reserves nothing for a runner whose lease another took over', async () => {
    const claim = await newClaim();
    await repository.renewClaim(claim, later);

    await expect(reserveUnder(claim, '2.00')).resolves.toEqual({ outcome: 'CLAIM_LOST' });
    expect(await prisma.costRecord.count()).toBe(0);
  });

  it.each([1, 2, 3, 4, 5])('lets only one of 4 campaigns fit a tight cap (round %d)', async () => {
    const claims = await Promise.all([newClaim(), newClaim(), newClaim(), newClaim()]);

    const results = await Promise.all(claims.map((claim) => reserveUnder(claim, '0.61')));

    expect(results.filter(({ outcome }) => outcome === 'RESERVED')).toHaveLength(1);
    expect(results.filter(({ outcome }) => outcome === 'OVER_CAP')).toHaveLength(3);
    await prisma.costRecord.deleteMany();
  });
});

// Proves a reservation's note can change from two sides without either write being lost.
describe('saveRunId, pauseForCheck and abandonSearch', () => {
  const reservation = async (claim: Claim): Promise<string> => {
    const reserved = await reserveUnder(claim, '2.00');
    if (reserved.outcome !== 'RESERVED') throw new Error('Expected a reservation');
    return reserved.recordId;
  };

  it('saves the run id and leaves the rest of the note alone', async () => {
    const recordId = await reservation(await newClaim());

    await repository.saveRunId(recordId, 'fictional-run');

    expect((await recordNote(recordId)).note).toEqual({
      term: 'fictional term',
      area: 'DHA',
      runId: 'fictional-run',
      state: 'OPEN',
    });
  });

  it('pauses and marks the record in one step', async () => {
    const claim = await newClaim();
    const recordId = await reservation(claim);

    await expect(repository.pauseForCheck(claim, recordId, 'Fictional reason')).resolves.toBe(true);

    expect(await campaign(claim.id)).toMatchObject({
      status: 'PAUSED',
      pauseReason: 'Fictional reason',
      discoveryClaimedAt: null,
    });
    expect((await recordNote(recordId)).note).toMatchObject({ runId: null, state: 'CHECK_APIFY' });
  });

  it('changes nothing for a stale runner', async () => {
    const claim = await newClaim();
    const recordId = await reservation(claim);
    await repository.renewClaim(claim, later);

    await expect(repository.pauseForCheck(claim, recordId, 'Fictional reason')).resolves.toBe(
      false,
    );

    expect((await campaign(claim.id)).status).toBe('DISCOVERING');
    expect((await recordNote(recordId)).note).toMatchObject({ state: 'OPEN' });
  });

  it('keeps a run id saved after the pause, so resume can collect that run', async () => {
    const claim = await newClaim();
    const recordId = await reservation(claim);
    await repository.pauseForCheck(claim, recordId, 'Fictional reason');

    await repository.saveRunId(recordId, 'fictional-run');

    expect((await recordNote(recordId)).note).toMatchObject({
      runId: 'fictional-run',
      state: 'CHECK_APIFY',
    });
  });

  it('abandons a record without giving its reservation back', async () => {
    const recordId = await reservation(await newClaim());

    await repository.abandonSearch(recordId);

    expect(await recordNote(recordId)).toMatchObject({
      amountUsd: '0.61',
      note: { state: 'ABANDONED' },
    });
    const spent = await repository.apifySpentSince(organizationId, dayStart);
    expect(spent.toFixed(2)).toBe('0.61');
  });
});

// Proves one search is stored once, whatever repeats it, and its charge replaces the reservation.
describe('storeSearch', () => {
  it('stores leads, counts and the true charge together', async () => {
    const { id: campaignId } = await newClaim();
    const recordId = await reserve(campaignId);
    const rows = [row(campaignId, 'a'), row(campaignId, 'b'), row(campaignId, 'a')];

    const stored = await repository.storeSearch({
      recordId,
      campaignId,
      rows,
      costUsd: new Prisma.Decimal('0.018'),
    });

    expect(stored).toEqual({ created: 2, duplicates: 1 });
    expect(await campaign(campaignId)).toMatchObject({ foundCount: 3, duplicateCount: 1 });
    const record = await prisma.costRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(record.units).toBe(3);
    expect(record.amountUsd.toFixed(3)).toBe('0.018');
  });

  it('keeps the reserved amount when the true charge is unknown', async () => {
    const { id: campaignId } = await newClaim();
    const recordId = await reserve(campaignId);

    await repository.storeSearch({ recordId, campaignId, rows: [], costUsd: null });

    const record = await prisma.costRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(record.amountUsd.toFixed(2)).toBe('0.61');
  });

  it('counts a place another campaign stored as a duplicate and leaves it alone', async () => {
    const { id: firstId } = await newClaim();
    await repository.storeSearch({
      recordId: await reserve(firstId),
      campaignId: firstId,
      rows: [row(firstId, 'a')],
      costUsd: null,
    });
    const { id: campaignId } = await newClaim();

    const stored = await repository.storeSearch({
      recordId: await reserve(campaignId),
      campaignId,
      rows: [row(campaignId, 'a')],
      costUsd: null,
    });

    expect(stored).toEqual({ created: 0, duplicates: 1 });
    const lead = await prisma.lead.findFirstOrThrow({ where: { placeId: 'a' } });
    expect(lead.campaignId).toBe(firstId);
  });

  it('adds nothing when the same search is stored twice', async () => {
    const { id: campaignId } = await newClaim();
    const search = {
      recordId: await reserve(campaignId),
      campaignId,
      rows: [row(campaignId, 'a')],
      costUsd: null,
    };

    await repository.storeSearch(search);
    await expect(repository.storeSearch(search)).resolves.toBeNull();

    expect(await campaign(campaignId)).toMatchObject({ foundCount: 1, duplicateCount: 0 });
  });

  it('adds nothing extra when two runners store the same search at once', async () => {
    const { id: campaignId } = await newClaim();
    const search = {
      recordId: await reserve(campaignId),
      campaignId,
      rows: [row(campaignId, 'a'), row(campaignId, 'b')],
      costUsd: null,
    };

    const results = await Promise.all([
      repository.storeSearch(search),
      repository.storeSearch(search),
    ]);

    expect(results.filter((result) => result !== null)).toHaveLength(1);
    expect(await campaign(campaignId)).toMatchObject({ foundCount: 2, duplicateCount: 0 });
  });
});

// Proves the last step is all or nothing, and its count comes from the rows.
describe('finishDiscovery', () => {
  it('marks rejections, counts them and moves on to ENRICHING', async () => {
    const claim = await newClaim();
    await prisma.lead.createMany({ data: [row(claim.id, 'a'), row(claim.id, 'b')] });
    const { id: leadId } = await prisma.lead.findFirstOrThrow({ where: { placeId: 'a' } });

    await expect(
      repository.finishDiscovery(claim, [{ leadId, reason: 'Fictional reason' }]),
    ).resolves.toBe(true);

    expect(await campaign(claim.id)).toMatchObject({
      status: 'ENRICHING',
      filteredCount: 1,
      discoveryClaimedAt: null,
    });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({
      status: 'FILTERED_OUT',
      filterReason: 'Fictional reason',
    });
  });

  it('changes no lead and no count for a stale runner', async () => {
    const claim = await newClaim();
    await prisma.lead.createMany({ data: [row(claim.id, 'a')] });
    const { id: leadId } = await prisma.lead.findFirstOrThrow({ where: { placeId: 'a' } });
    await repository.renewClaim(claim, later);

    await expect(
      repository.finishDiscovery(claim, [{ leadId, reason: 'Fictional reason' }]),
    ).resolves.toBe(false);

    expect(await campaign(claim.id)).toMatchObject({ status: 'DISCOVERING', filteredCount: 0 });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({
      status: 'DISCOVERED',
      filterReason: null,
    });
  });

  it('finishes the largest grid, 8,000 rejections, inside one transaction', async () => {
    const claim = await newClaim();
    const placeIds = Array.from({ length: 8000 }, (_, index) => `place-${String(index)}`);
    await prisma.lead.createMany({ data: placeIds.map((placeId) => row(claim.id, placeId)) });
    const leads = await prisma.lead.findMany({ select: { id: true } });
    const rejections = leads.map(({ id }, index) => ({
      leadId: id,
      reason: `Fictional reason ${String(index % 3)}`,
    }));

    await expect(repository.finishDiscovery(claim, rejections)).resolves.toBe(true);

    expect(await campaign(claim.id)).toMatchObject({ status: 'ENRICHING', filteredCount: 8000 });
    const reasons = await prisma.lead.groupBy({ by: ['filterReason'], _count: true });
    expect(reasons).toHaveLength(3);
  }, 60_000);
});
