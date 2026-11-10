/**
 * Integration test of pass-2 reviews enrichment against real Postgres with the fake lead source.
 *
 * Serves: FR-11, FR-33, NFR-4, ADR-0015; issue #12 (pass-2 reviews and its money rules).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { resolve } from 'node:path';
import type { HazelApp } from '@hazeljs/core';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { NO_REVIEWS_ERROR, ReviewRepository } from '../src/db/review.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { Prisma } from '../src/generated/prisma/client.js';
import type { Logger } from '../src/logging/logger.js';
import { enrichReviewsForCampaign } from '../src/pipeline/enrich-reviews.step.js';
import { readReviewsRunNote, reviewsRunNote } from '../src/pipeline/reviews-run-note.js';
import { LEAD_SOURCE, type LeadSourcePort } from '../src/ports/lead-source.port.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let reviewRepo: ReviewRepository;
let leadSource: LeadSourcePort;
let campaignId: string;
let nicheProfileId: string;
const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn() } as unknown as Logger;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_reviews_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  const container = app.getContainer();
  prisma = container.resolve(PrismaProvider);
  reviewRepo = container.resolve(ReviewRepository);
  leadSource = container.resolve<LeadSourcePort>(LEAD_SOURCE);

  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  nicheProfileId = (await prisma.nicheProfile.findFirstOrThrow()).id;
  campaignId = (await newCampaign()).id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.review.deleteMany();
  await prisma.lead.deleteMany();
  await prisma.costRecord.deleteMany();
  await setCap('2.00');
});

const newCampaign = () =>
  prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId, city: 'Lahore' },
  });

// Fictional place ids that the fake's review fixtures cover.
const addLeads = (placeIds: readonly string[], forCampaign = campaignId) =>
  prisma.lead.createMany({
    data: placeIds.map((placeId) => ({
      organizationId: SEED_ORGANIZATION_ID,
      campaignId: forCampaign,
      placeId,
      name: `Fictional clinic ${placeId}`,
      rawPlace: {},
      status: 'DISCOVERED' as const,
    })),
  });

const setCap = (apifyDailyUsd: string) =>
  prisma.settings.update({
    where: { organizationId: SEED_ORGANIZATION_ID },
    data: { spendCaps: { ...DEFAULT_SETTINGS.spendCaps, apifyDailyUsd } },
  });

const apifyRecords = () => prisma.costRecord.findMany({ where: { service: 'APIFY' } });

const run = (forCampaign = campaignId) =>
  enrichReviewsForCampaign({ prisma, reviewRepo, leadSource, logger }, forCampaign);

// Counts the paid starts of the fake, and runs them as usual unless a test makes one fail.
const watchStarts = () => jest.spyOn(leadSource, 'startReviews');

afterEach(() => {
  jest.restoreAllMocks();
});

// Proves the happy path: one reservation becomes the one cost record of the run, with its true charge.
describe('enrichReviewsForCampaign', () => {
  it('stores reviews with author null, under one APIFY record per run', async () => {
    await addLeads(['fictional-place-p01', 'fictional-place-p02']);
    // A deferral from an earlier call, which a later success must clear.
    await prisma.lead.updateMany({
      data: {
        failedStep: 'ENRICH_REVIEWS',
        error: 'Apify daily spend cap reached; reviews wait until the cap has room',
      },
    });

    const result = await run(campaignId);

    expect(result).toMatchObject({ placeCount: 2, skippedDueToCap: false, needsCheck: false });
    const marked = await prisma.lead.count({
      where: { OR: [{ failedStep: { not: null } }, { error: { not: null } }] },
    });
    expect(marked).toBe(0);
    expect(result.storedReviewsCount).toBeGreaterThan(0);
    const stored = await prisma.review.findMany();
    expect(stored).toHaveLength(result.storedReviewsCount);
    for (const review of stored) expect(review.author).toBeNull();
    const records = await apifyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.units).toBe(2);
    expect(readReviewsRunNote(records[0]?.note ?? null)?.runId).not.toBeNull();
    // The fake charges less than the limit it reserved: the true charge replaced the reservation.
    expect(records[0]?.amountUsd.lessThan(leadSource.chargeLimitReviewsUsd(2))).toBe(true);
  });
});

// Proves two paid runs racing for the last dollars of the cap cannot both be reserved.
describe('enrichReviewsForCampaign under parallel runs', () => {
  it('lets only one of two parallel runs reserve when only one fits the cap', async () => {
    const other = await newCampaign();
    await addLeads(['fictional-place-p01', 'fictional-place-p02']);
    await addLeads(['fictional-place-p03', 'fictional-place-p06'], other.id);
    // Each run may charge 2 x $0.008: the cap holds one of them and not both.
    await setCap('0.02');
    const starts = watchStarts();

    const results = await Promise.all([run(), run(other.id)]);

    expect(results.filter((result) => result.skippedDueToCap)).toHaveLength(1);
    expect(starts).toHaveBeenCalledTimes(1);
    const total = (await apifyRecords()).reduce(
      (sum, record) => sum.plus(record.amountUsd),
      new Prisma.Decimal(0),
    );
    expect(total.lessThanOrEqualTo('0.02')).toBe(true);
  });
});

const reserveWithoutRunId = () =>
  prisma.costRecord.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      service: 'APIFY',
      amountUsd: new Prisma.Decimal('0.008'),
      note: reviewsRunNote({ runId: null, placeIds: ['fictional-place-p01'] }),
    },
  });

// Proves a crash or failure between the reservation and the run id leaves a trace, never a second run.
describe('enrichReviewsForCampaign after a lost start', () => {
  it('starts nothing over a reservation that has no run id, however often it is called', async () => {
    await addLeads(['fictional-place-p01']);
    await reserveWithoutRunId();
    const starts = watchStarts();

    const [first, second] = [await run(), await run()];

    expect([first.needsCheck, second.needsCheck]).toEqual([true, true]);
    expect(starts).not.toHaveBeenCalled();
    expect(await apifyRecords()).toHaveLength(1);
    expect((await prisma.lead.findFirstOrThrow()).failedStep).toBe('ENRICH_REVIEWS');
  });

  it('keeps the reservation when the start fails, then pays again only once abandoned', async () => {
    await addLeads(['fictional-place-p01']);
    const starts = watchStarts().mockRejectedValueOnce(new Error('fictional outage'));

    const failed = await run();
    const blocked = await run();

    expect([failed.needsCheck, blocked.needsCheck]).toEqual([true, true]);
    expect(starts).toHaveBeenCalledTimes(1);
    const [lost] = await apifyRecords();
    await new DiscoveryRepository(prisma).abandonSearch(lost?.id ?? '');

    const retried = await run();

    expect(retried.needsCheck).toBe(false);
    expect(starts).toHaveBeenCalledTimes(2);
    // The abandoned reservation stays on the day's total beside the new record.
    expect(await apifyRecords()).toHaveLength(2);
  });

  it('collects a saved run id for free instead of starting again', async () => {
    await addLeads(['fictional-place-p01']);
    const runId = await leadSource.startReviews(['fictional-place-p01'], new Prisma.Decimal('1'));
    const record = await reserveWithoutRunId();
    await reviewRepo.saveRunId(record.id, runId);
    const starts = watchStarts();

    const result = await run();

    expect(result.storedReviewsCount).toBeGreaterThan(0);
    expect(starts).not.toHaveBeenCalled();
    const records = await apifyRecords();
    expect(records).toHaveLength(1);
    expect(records[0]?.units).toBe(1);
  });

  it('finishes a run whose reviews were stored but whose record a crash left open', async () => {
    await addLeads(['fictional-place-p01']);
    const runId = await leadSource.startReviews(['fictional-place-p01'], new Prisma.Decimal('1'));
    const record = await reserveWithoutRunId();
    await reviewRepo.saveRunId(record.id, runId);
    const lead = await prisma.lead.findFirstOrThrow();
    await reviewRepo.saveReviews(lead.id, oneReview('fictional-place-p01').reviews);
    const starts = watchStarts();

    const result = await run();

    expect(result.placeCount).toBe(0);
    expect(starts).not.toHaveBeenCalled();
    expect(await reviewRepo.openRun(campaignId)).toBeNull();
  });

  it('leaves a stale open record open, and does not throw, when its run is still running', async () => {
    await addLeads(['fictional-place-p01']);
    const record = await reserveWithoutRunId();
    await reviewRepo.saveRunId(record.id, 'fictional-run-still-going');
    const lead = await prisma.lead.findFirstOrThrow();
    await reviewRepo.saveReviews(lead.id, oneReview('fictional-place-p01').reviews);
    jest.spyOn(leadSource, 'collectReviews').mockRejectedValueOnce(new Error('still RUNNING'));

    await expect(run()).resolves.toMatchObject({ placeCount: 0 });

    expect((await reviewRepo.openRun(campaignId))?.recordId).toBe(record.id);
  });

  it('never touches or collects the open run of another campaign', async () => {
    const other = await newCampaign();
    await addLeads(['fictional-place-p01']);
    const record = await reserveWithoutRunId();
    await reviewRepo.saveRunId(record.id, 'fictional-run-of-the-first');
    await addLeads(['fictional-place-p02'], other.id);
    const reads = jest.spyOn(leadSource, 'collectReviews');
    const starts = watchStarts();

    await run(other.id);

    expect(starts).toHaveBeenCalledTimes(1);
    expect(reads).toHaveBeenCalledTimes(1);
    expect(reads).not.toHaveBeenCalledWith('fictional-run-of-the-first');
    expect((await reviewRepo.openRun(campaignId))?.recordId).toBe(record.id);
  });
});

const oneReview = (placeId: string) => ({
  placeId,
  reviews: [
    {
      reviewId: `${placeId}-review-1`,
      text: 'Fictional review text',
      stars: 3,
      publishedAtDate: '2026-10-01T00:00:00.000Z',
      responseFromOwnerText: null,
      responseFromOwnerDate: null,
      language: 'en',
      originalLanguage: 'en',
    },
  ],
});

// Proves a paid run that ended badly is not paid for again without a founder action (Fahad's #10 rule).
describe('enrichReviewsForCampaign after a paid run that ended badly', () => {
  it.each([
    ['an empty run', 'SUCCEEDED' as const, [], 2],
    [
      'a FAILED run that returned one place',
      'FAILED' as const,
      [oneReview('fictional-place-p01')],
      1,
    ],
  ])('does not pay again after %s', async (_case, status, items, withoutReviews) => {
    await addLeads(['fictional-place-p01', 'fictional-place-p02']);
    jest
      .spyOn(leadSource, 'collectReviews')
      .mockResolvedValueOnce({ items, costUsd: null, status, skippedCount: 0 });
    const starts = watchStarts();

    const first = await run();
    const second = await run();

    expect(first.problem).toContain(status === 'FAILED' ? 'FAILED' : 'no reviews');
    expect(second).toMatchObject({ placeCount: 0, problem: null });
    expect(starts).toHaveBeenCalledTimes(1);
    expect(await apifyRecords()).toHaveLength(1);
    expect(await prisma.lead.count({ where: { error: NO_REVIEWS_ERROR } })).toBe(withoutReviews);
  });
});

// Proves the run size follows the room under the cap, and a deferral says what is true.
describe('enrichReviewsForCampaign at the edge of the cap', () => {
  it.each([
    ['exactly fits the cap', ['p01', 'p02', 'p03'], 0],
    ['is one place over the cap', ['p01', 'p02', 'p03', 'p06'], 1],
  ])('when the run %s, defers %i place(s) and runs the rest', async (_case, ids, deferred) => {
    await addLeads(ids.map((id) => `fictional-place-${id}`));
    await setCap('0.03');

    const result = await run();

    expect(result.placeCount).toBe(3);
    expect(result.skippedDueToCap).toBe(deferred > 0);
    const waiting = await prisma.lead.findMany({ where: { failedStep: 'ENRICH_REVIEWS' } });
    expect(waiting).toHaveLength(deferred);
    for (const lead of waiting) expect(lead.error).toContain('wait until the cap has room');
    expect((await apifyRecords())[0]?.units).toBe(3);
  });

  it('defers every lead and starts nothing when not even one place fits', async () => {
    await addLeads(['fictional-place-p03']);
    await setCap('0.00');
    const starts = watchStarts();

    const result = await run();

    expect(result).toMatchObject({ placeCount: 0, skippedDueToCap: true });
    expect(starts).not.toHaveBeenCalled();
    expect(await apifyRecords()).toHaveLength(0);
  });
});

// Proves a resumed run marks the misses of its own leads, and leaves leads added later alone.
describe('enrichReviewsForCampaign when a paid run is resumed', () => {
  it.each([
    ['an empty run', 'SUCCEEDED' as const, [], ['p01', 'p02']],
    ['a FAILED run', 'FAILED' as const, [oneReview('fictional-place-p01')], ['p02']],
  ])('does not pay again after resuming %s', async (_case, status, items, marked) => {
    await addLeads(['fictional-place-p01', 'fictional-place-p02']);
    const read = jest
      .spyOn(leadSource, 'collectReviews')
      .mockRejectedValueOnce(new Error('still RUNNING'));
    const starts = watchStarts();
    await expect(run()).rejects.toThrow('still RUNNING');
    // Added after the reservation, so it is not one of the run's places.
    await addLeads(['fictional-place-p03']);
    read.mockResolvedValueOnce({ items, costUsd: null, status, skippedCount: 0 });

    const resumed = await run();

    expect(resumed.placeCount).toBe(2);
    expect(resumed.problem).toContain(status === 'FAILED' ? 'FAILED' : 'no reviews');
    expect(starts).toHaveBeenCalledTimes(1);
    const terminal = await prisma.lead.findMany({ where: { error: NO_REVIEWS_ERROR } });
    expect(terminal.map((lead) => lead.placeId).sort((a, b) => a.localeCompare(b))).toEqual(
      marked.map((id) => `fictional-place-${id}`),
    );
    const late = await prisma.lead.findFirstOrThrow({ where: { placeId: 'fictional-place-p03' } });
    expect([late.failedStep, late.error]).toEqual([null, null]);
  });
});
