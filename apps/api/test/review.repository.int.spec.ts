/**
 * Integration test of the review repository against real Postgres.
 *
 * Serves: FR-11, FR-13 (labels survive a repeat save), FR-33, NFR-4 (reservation under the cap),
 * ADR-0015; issues #12 and #13.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import type { HazelApp } from '@hazeljs/core';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { NO_REVIEWS_ERROR, ReviewRepository } from '../src/db/review.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { Prisma } from '../src/generated/prisma/client.js';
import { readReviewsRunNote } from '../src/pipeline/reviews-run-note.js';
import { karachiDayStart, spendLockName } from '../src/pipeline/spend-cap.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let reviewRepo: ReviewRepository;
let campaignId: string;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_review_repo_test');
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  prisma = app.getContainer().resolve(PrismaProvider);
  reviewRepo = app.getContainer().resolve(ReviewRepository);
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  const campaign = await prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
  });
  campaignId = campaign.id;
}, 120_000);

afterAll(async () => {
  await app.close();
  await prisma.$disconnect();
});

beforeEach(async () => {
  await prisma.review.deleteMany();
  await prisma.lead.deleteMany();
});

const addLead = (placeId: string, status: 'DISCOVERED' | 'FILTERED_OUT' = 'DISCOVERED') =>
  prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId,
      name: `Fictional clinic ${placeId}`,
      rawPlace: {},
      status,
    },
  });

const rawReview = (index: number) => ({
  reviewId: `fictional-review-${String(index)}`,
  text: `Fictional review text ${String(index)}`,
  stars: 4,
  publishedAtDate: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
  responseFromOwnerText: index === 0 ? 'Thank you' : null,
  responseFromOwnerDate: null,
  language: 'en',
  originalLanguage: 'en',
});

const reviewsOf = (leadId: string) =>
  prisma.review.findMany({ where: { leadId }, orderBy: { publishedAt: 'desc' } });

// Proves only leads that passed the filter and have no reviews are sent to the paid pass-2 run.
describe('ReviewRepository.leadsNeedingReviews', () => {
  it('lists leads without reviews and leaves out filtered-out leads and leads with reviews', async () => {
    const needing = await addLead('fictional-place-a');
    await addLead('fictional-place-b', 'FILTERED_OUT');
    const done = await addLead('fictional-place-c');
    await reviewRepo.saveReviews(done.id, [rawReview(1)]);

    const leads = await reviewRepo.leadsNeedingReviews(campaignId);

    expect(leads).toEqual([{ id: needing.id, placeId: 'fictional-place-a' }]);
  });

  it('leaves out a lead whose paid run returned nothing, but keeps one deferred by the cap', async () => {
    const paid = await addLead('fictional-place-a');
    const deferred = await addLead('fictional-place-b');
    await prisma.lead.update({
      where: { id: paid.id },
      data: { failedStep: 'ENRICH_REVIEWS', error: NO_REVIEWS_ERROR },
    });
    await prisma.lead.update({
      where: { id: deferred.id },
      data: { failedStep: 'ENRICH_REVIEWS', error: 'Apify daily spend cap reached' },
    });

    const leads = await reviewRepo.leadsNeedingReviews(campaignId);

    expect(leads.map((lead) => lead.id)).toEqual([deferred.id]);
  });
});

// Proves reviews are stored once, newest 30 only, with the rating, date and reply flag and no author,
// and that a repeat save never wipes their labels.
describe('ReviewRepository.saveReviews', () => {
  it('keeps the 30 newest, stores no author, and does not duplicate on a repeat', async () => {
    const lead = await addLead('fictional-place-a');
    const reviews = Array.from({ length: 35 }, (_, index) => rawReview(index));

    const first = await reviewRepo.saveReviews(lead.id, reviews);
    const second = await reviewRepo.saveReviews(lead.id, reviews);

    expect(first).toBe(30);
    expect(second).toBe(30);
    const stored = await reviewsOf(lead.id);
    expect(stored).toHaveLength(30);
    expect(stored.every((review) => review.author === null)).toBe(true);
    expect(stored[0]?.externalId).toBe('fictional-review-34');
    expect(stored[0]?.rating).toBe(4);
    expect(stored[0]?.publishedAt).not.toBeNull();
  });

  it('stores a new review unlabelled and keeps its labels when the same review is saved again', async () => {
    const lead = await addLead('fictional-place-a');
    await reviewRepo.saveReviews(lead.id, [rawReview(0)]);
    expect((await reviewsOf(lead.id))[0]?.labels).toEqual([]);
    await prisma.review.updateMany({
      where: { leadId: lead.id },
      data: { labels: ['PHONE_UNANSWERED'] },
    });

    await reviewRepo.saveReviews(lead.id, [rawReview(0)]);

    expect((await reviewsOf(lead.id))[0]?.labels).toEqual(['PHONE_UNANSWERED']);
  });

  it('records an owner reply as a flag, not as text', async () => {
    const lead = await addLead('fictional-place-a');

    await reviewRepo.saveReviews(lead.id, [rawReview(0)]);

    expect((await reviewsOf(lead.id))[0]?.ownerReplied).toBe(true);
  });

  it('stores nothing for a lead with no reviews', async () => {
    const lead = await addLead('fictional-place-a');

    expect(await reviewRepo.saveReviews(lead.id, [])).toBe(0);
  });
});

const newCampaign = async () => {
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  return prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
  });
};

const setCap = (apifyDailyUsd: string) =>
  prisma.settings.update({
    where: { organizationId: SEED_ORGANIZATION_ID },
    data: { spendCaps: { ...DEFAULT_SETTINGS.spendCaps, apifyDailyUsd } },
  });

const reserve = (forCampaign: string, amountUsd: string, placeCount = 1) =>
  reviewRepo.reserveRun({
    organizationId: SEED_ORGANIZATION_ID,
    campaignId: forCampaign,
    placeIds: Array.from({ length: placeCount }, (_, index) => `fictional-place-${String(index)}`),
    limitFor: (places) => new Prisma.Decimal(amountUsd).times(places),
    dayStart: karachiDayStart(new Date()),
    at: new Date(),
  });

// Proves the reservation is the money rule: it counts at once, takes turns, and reads the cap under the lock.
describe('ReviewRepository.reserveRun', () => {
  beforeEach(async () => {
    await prisma.costRecord.deleteMany();
    await setCap('2.00');
  });

  it('reserves one record per run and counts it on the day total', async () => {
    const first = await reserve(campaignId, '0.50');

    expect(first.outcome).toBe('RESERVED');
    const records = await prisma.costRecord.findMany({ where: { service: 'APIFY' } });
    expect(records.map((record) => record.amountUsd.toString())).toEqual(['0.5']);
  });

  it('lets only one of two parallel reservations fit a cap that holds one', async () => {
    const other = await newCampaign();
    await setCap('1.00');

    const outcomes = await Promise.all([reserve(campaignId, '0.60'), reserve(other.id, '0.60')]);

    expect(outcomes.map((outcome) => outcome.outcome).sort((a, b) => a.localeCompare(b))).toEqual([
      'OVER_CAP',
      'RESERVED',
    ]);
    expect(await prisma.costRecord.count({ where: { service: 'APIFY' } })).toBe(1);
  });

  it.each([
    ['has room for part', '0.45', 'RESERVED', 2],
    ['has room for none', '0.15', 'OVER_CAP', 0],
  ])(
    'when the cap %s, reserves for as many places as fit',
    async (_case, cap, outcome, covered) => {
      await setCap(cap);

      const reservation = await reserve(campaignId, '0.20', 5);

      expect(reservation.outcome).toBe(outcome);
      if (reservation.outcome === 'RESERVED') {
        expect(reservation.placeCount).toBe(covered);
        // The note keeps the places the reservation covers, in the order given.
        const record = await prisma.costRecord.findUniqueOrThrow({
          where: { id: reservation.recordId },
        });
        expect(readReviewsRunNote(record.note)?.placeIds).toHaveLength(covered);
        expect(readReviewsRunNote(record.note)?.placeIds[0]).toBe('fictional-place-0');
        expect(reservation.amountUsd.toString()).toBe(String(0.2 * covered));
      }
    },
  );

  it('gives back the unfinished run of a campaign instead of reserving a second one', async () => {
    const first = await reserve(campaignId, '0.10');
    const second = await reserve(campaignId, '0.10');

    expect(second).toEqual({
      outcome: 'EXISTING',
      recordId: first.outcome === 'RESERVED' ? first.recordId : '',
      runId: null,
      placeIds: ['fictional-place-0'],
    });
    expect(await prisma.costRecord.count({ where: { service: 'APIFY' } })).toBe(1);
    expect(await reviewRepo.openRun(campaignId)).toEqual({
      recordId: first.outcome === 'RESERVED' ? first.recordId : '',
      runId: null,
      placeIds: ['fictional-place-0'],
    });
  });

  it('reads the cap under the lock, so a cap lowered while it waits holds', async () => {
    let settled = false;
    let reservation: ReturnType<typeof reserve> | undefined;

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${spendLockName(SEED_ORGANIZATION_ID)}, 0))`;
      reservation = reserve(campaignId, '0.50').finally(() => {
        settled = true;
      });
      await new Promise((wait) => setTimeout(wait, 500));
      expect(settled).toBe(false);
      await tx.settings.update({
        where: { organizationId: SEED_ORGANIZATION_ID },
        data: { spendCaps: { ...DEFAULT_SETTINGS.spendCaps, apifyDailyUsd: '0.10' } },
      });
    });

    expect((await reservation)?.outcome).toBe('OVER_CAP');
    expect(await prisma.costRecord.count({ where: { service: 'APIFY' } })).toBe(0);
  });
});

// Proves the run id and the true charge land on the same record, and a charge never goes unsaid.
describe('ReviewRepository.saveRunId and finishRun', () => {
  beforeEach(async () => {
    await prisma.costRecord.deleteMany();
    await setCap('2.00');
  });

  it('saves the run id in the note, keeps the amount, then sets the true charge', async () => {
    const reserved = await reserve(campaignId, '0.50');
    const recordId = reserved.outcome === 'RESERVED' ? reserved.recordId : '';

    await reviewRepo.saveRunId(recordId, 'fictional-run-1');
    await reviewRepo.finishRun(recordId, 3, new Prisma.Decimal('0.02'));

    const record = await prisma.costRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(readReviewsRunNote(record.note)?.runId).toBe('fictional-run-1');
    expect(record.units).toBe(3);
    expect(record.amountUsd.toString()).toBe('0.02');
  });

  it('keeps the reserved amount when the run did not say what it charged', async () => {
    const reserved = await reserve(campaignId, '0.50');
    const recordId = reserved.outcome === 'RESERVED' ? reserved.recordId : '';

    await reviewRepo.finishRun(recordId, 3, null);

    const record = await prisma.costRecord.findUniqueOrThrow({ where: { id: recordId } });
    expect(record.amountUsd.toString()).toBe('0.5');
  });
});
