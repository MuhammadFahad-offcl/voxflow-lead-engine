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
import { ReviewRepository } from '../src/db/review.repository.js';
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

    const result = await run(campaignId);

    expect(result).toMatchObject({ placeCount: 2, skippedDueToCap: false, needsCheck: false });
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
});
