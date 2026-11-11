/**
 * Integration test of the review-labelling step on real Postgres, through the real LLM gate with a
 * stub model: which reviews are sent, what is stored, and what happens when the model fails, answers
 * badly or the monthly cap is reached.
 *
 * Serves: FR-13, FR-33, NFR-4; issue #13.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { DEFAULT_SETTINGS } from '@voxflow/shared';
import { resolve } from 'node:path';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { ReviewLabelRepository } from '../src/db/review-label.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { LlmService } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import { labelReviews } from '../src/pipeline/label-reviews.step.js';
import { LlmError, type LlmPort, type LlmReply, type LlmRequest } from '../src/ports/llm.port.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

type Answer = (request: LlmRequest) => LlmReply | Error;

const reply = (text: string): LlmReply => ({
  text,
  usage: { inputTokens: 2_000, outputTokens: 400 },
  model: 'claude-haiku-5-5',
  stopReason: 'end_turn',
});
// The reviews are the prompt's first line; a retry appends the gate's problem list below it.
const sentIds = (request: LlmRequest): string[] =>
  (JSON.parse(request.user.split('\n')[0] ?? '') as { reviews: { id: string }[] }).reviews.map(
    (review) => review.id,
  );
// Answers every review it was sent with the given labels.
const labelAll =
  (...labels: string[]): Answer =>
  (request) =>
    reply(JSON.stringify({ reviews: sentIds(request).map((id) => ({ id, labels })) }));

/** A model that answers with the next function in the queue and keeps every request. */
class StubModel implements LlmPort {
  requests: LlmRequest[] = [];
  answers: Answer[] = [];
  complete(request: LlmRequest): Promise<LlmReply> {
    this.requests.push(request);
    const next = (this.answers.shift() ?? labelAll('OTHER'))(request);
    return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
  }
}

let prisma: PrismaProvider;
let model: StubModel;
// The first request the model got; a test that expects one fails here if there was none.
const firstRequest = (): LlmRequest => {
  const [request] = model.requests;
  if (request === undefined) throw new Error('the model got no request');
  return request;
};
let campaignId = '';
let place = 0;
const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as Logger;
const deps = () => ({
  reviews: new ReviewLabelRepository(prisma),
  llm: new LlmService(new LlmSpendRepository(prisma), model, logger),
  logger,
});

// A lead with `count` fictional reviews, one per day back from 1 Nov 2026, newest first.
const leadWithReviews = async (count: number, status: 'ENRICHED' | 'FILTERED_OUT' = 'ENRICHED') => {
  place += 1;
  const lead = await prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId: `label-${String(place)}`,
      name: 'Fictional Clinic',
      rawPlace: {},
      status,
    },
  });
  await prisma.review.createMany({
    data: Array.from({ length: count }, (_, index) => ({
      leadId: lead.id,
      externalId: `fictional-review-${String(index)}`,
      text: `Fictional review ${String(index)}`,
      rating: 3,
      publishedAt: new Date(Date.UTC(2026, 10, 1 - index)),
    })),
  });
  return lead.id;
};
const reviewsOf = (leadId: string) =>
  prisma.review.findMany({ where: { leadId }, orderBy: { publishedAt: 'desc' } });

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_label_reviews_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  ({ id: campaignId } = await prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
  }));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

beforeEach(async () => {
  model = new StubModel();
  jest.clearAllMocks();
  // Each test starts with the whole month's LLM budget.
  await prisma.costRecord.deleteMany({ where: { service: 'LLM' } });
  await prisma.settings.update({
    where: { organizationId: SEED_ORGANIZATION_ID },
    data: { spendCaps: DEFAULT_SETTINGS.spendCaps },
  });
});

// Proves one call labels the 30 newest unlabelled reviews and stores the labels and the cost.
describe('labelReviews', () => {
  it('sends the 30 newest reviews in one call and stores their labels and cost', async () => {
    const leadId = await leadWithReviews(32);

    const outcome = await labelReviews(deps(), leadId);

    expect(outcome).toEqual({ status: 'LABELLED', reviews: 30 });
    expect(model.requests).toHaveLength(1);
    expect(model.requests[0]).toMatchObject({
      task: 'REVIEW_LABELLING',
      model: 'claude-haiku-5-5',
    });
    expect(model.requests[0]?.system).toContain('PHONE_UNANSWERED, BOOKING_OR_WAIT');
    expect(sentIds(firstRequest())).toHaveLength(30);
    const stored = await reviewsOf(leadId);
    expect(stored.slice(0, 30).every((review) => review.labels[0] === 'OTHER')).toBe(true);
    // The two oldest are outside the 30 newest that scoring counts.
    expect(stored.slice(30).map((review) => review.labels)).toEqual([[], []]);
    const cost = await prisma.costRecord.findFirstOrThrow({ where: { leadId, service: 'LLM' } });
    expect(cost).toMatchObject({ campaignId, units: 2_400 });
  });

  it('sends only unlabelled reviews, and nothing once all are labelled', async () => {
    const leadId = await leadWithReviews(3);
    const [newest] = await reviewsOf(leadId);
    await prisma.review.update({
      where: { id: newest?.id ?? '' },
      data: { labels: ['POSITIVE'] },
    });

    await labelReviews(deps(), leadId);
    const again = await labelReviews(deps(), leadId);

    expect(sentIds(firstRequest())).toEqual(['r1', 'r2']);
    expect(again).toEqual({ status: 'SKIPPED', reason: 'NOTHING_TO_LABEL' });
    expect(model.requests).toHaveLength(1);
    expect((await reviewsOf(leadId))[0]?.labels).toEqual(['POSITIVE']);
  });

  it('skips a filtered-out lead without a call', async () => {
    const leadId = await leadWithReviews(2, 'FILTERED_OUT');

    expect(await labelReviews(deps(), leadId)).toEqual({
      status: 'SKIPPED',
      reason: 'FILTERED_OUT',
    });
    expect(model.requests).toHaveLength(0);
  });
});

// Proves a star-only review is never sent to the model and earns no points: it is labelled OTHER.
describe('labelReviews with reviews that have no text', () => {
  const blankOut = async (leadId: string, count: number) => {
    const newest = (await reviewsOf(leadId)).slice(0, count).map((review) => review.id);
    await prisma.review.updateMany({ where: { id: { in: newest } }, data: { text: '' } });
  };

  it('labels the blank review OTHER in code and sends only the others', async () => {
    const leadId = await leadWithReviews(3);
    await blankOut(leadId, 1);
    model.answers = [labelAll('PHONE_UNANSWERED')];

    expect(await labelReviews(deps(), leadId)).toEqual({ status: 'LABELLED', reviews: 3 });
    expect(sentIds(firstRequest())).toEqual(['r1', 'r2']);
    expect((await reviewsOf(leadId)).map((review) => review.labels)).toEqual([
      ['OTHER'],
      ['PHONE_UNANSWERED'],
      ['PHONE_UNANSWERED'],
    ]);
  });

  it('makes no call at all when every unlabelled review is blank', async () => {
    const leadId = await leadWithReviews(2);
    await blankOut(leadId, 2);

    expect(await labelReviews(deps(), leadId)).toEqual({ status: 'LABELLED', reviews: 2 });
    expect(model.requests).toHaveLength(0);
    expect(await prisma.costRecord.count({ where: { leadId } })).toBe(0);
  });
});

// Proves labels are written once: a second save, as from a racing run, changes nothing.
describe('ReviewLabelRepository.saveLabels', () => {
  it('never overwrites labels a review already has', async () => {
    const leadId = await leadWithReviews(1);
    const [review] = await reviewsOf(leadId);
    const reviewId = review?.id ?? '';
    const repository = new ReviewLabelRepository(prisma);

    const first = await repository.saveLabels([{ reviewId, labels: ['POSITIVE'] }]);
    const second = await repository.saveLabels([{ reviewId, labels: ['PRICE'] }]);

    expect([first, second]).toEqual([1, 0]);
    expect((await reviewsOf(leadId))[0]?.labels).toEqual(['POSITIVE']);
  });
});

// Proves bad answers, failures and the cap leave reviews unlabelled and say why.
describe('labelReviews when it goes wrong', () => {
  it('retries an answer with a review missing, and stores the corrected answer', async () => {
    const leadId = await leadWithReviews(2);
    model.answers = [
      () => reply(JSON.stringify({ reviews: [{ id: 'r1', labels: ['OTHER'] }] })),
      labelAll('PRICE'),
    ];

    expect(await labelReviews(deps(), leadId)).toEqual({ status: 'LABELLED', reviews: 2 });
    expect(model.requests[1]?.user).toContain('Missing: r2');
  });

  it('fails after two answers with an unknown review id, storing no labels', async () => {
    const leadId = await leadWithReviews(2);
    const unknown = () =>
      reply(
        JSON.stringify({
          reviews: [
            { id: 'r1', labels: ['OTHER'] },
            { id: 'r2', labels: ['OTHER'] },
            { id: 'r7', labels: ['OTHER'] },
          ],
        }),
      );
    model.answers = [unknown, unknown];

    expect(await labelReviews(deps(), leadId)).toEqual({ status: 'FAILED' });
    expect((await reviewsOf(leadId)).every((review) => review.labels.length === 0)).toBe(true);
    // Both answers were paid for.
    expect(await prisma.costRecord.count({ where: { leadId, service: 'LLM' } })).toBe(2);
  });

  it('fails when the model call fails, storing no labels', async () => {
    const leadId = await leadWithReviews(2);
    model.answers = [() => new LlmError('Anthropic API refused the request: HTTP 400', false)];

    expect(await labelReviews(deps(), leadId)).toEqual({ status: 'FAILED' });
    expect((await reviewsOf(leadId)).every((review) => review.labels.length === 0)).toBe(true);
  });

  it('reports the cap without a call when the month has no room left', async () => {
    const leadId = await leadWithReviews(2);
    await prisma.costRecord.create({
      data: { organizationId: SEED_ORGANIZATION_ID, service: 'LLM', amountUsd: '10.00' },
    });

    const outcome = await labelReviews(deps(), leadId);

    expect(outcome).toMatchObject({ status: 'CAP_REACHED' });
    expect((outcome as { reason: string }).reason).toMatch(/^LLM monthly cap: \$10\.0000 spent/);
    expect(model.requests).toHaveLength(0);
  });
});
