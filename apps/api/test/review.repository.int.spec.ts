/**
 * Integration test of the review repository against real Postgres.
 *
 * Serves: FR-11 (store up to 30 most recent Google reviews per business), ADR-0015; issue #12.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import type { HazelApp } from '@hazeljs/core';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { NO_REVIEWS_ERROR, ReviewRepository } from '../src/db/review.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
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

// Proves reviews are stored once, newest 30 only, with the rating, date and reply flag and no author.
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
