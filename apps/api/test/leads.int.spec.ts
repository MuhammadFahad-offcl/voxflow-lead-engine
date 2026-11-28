/**
 * Integration tests of the `/leads` routes over HTTP on a test database: `POST /leads/:id/retry`
 * re-queues a FAILED lead from its failed step, once; `GET /leads/:id` returns one lead for its
 * detail page, reviews without authors, and its Solution as stored.
 *
 * Serves: FR-32 (retry button); issue #15 acceptance ("given a failed lead, when retry is
 * triggered, then it runs again from the failed step"); FR-30 (lead detail), FR-17, issue #24.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import { LeadDetail } from '@voxflow/shared';
import { resolve } from 'node:path';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { startServer } from '../src/server.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let app: HazelApp;
let prisma: PrismaProvider;
let baseUrl: string;
let campaignId: string;

const retry = async (id: string) => {
  const response = await fetch(`${baseUrl}/leads/${id}/retry`, { method: 'POST' });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
};

/** A test lead's status and failure fields. */
interface LeadState {
  status: 'FAILED' | 'SCORED';
  failedStep?: string;
  error?: string;
}

/**
 * Stores a fictional lead in the test campaign.
 * @param placeId - Its unique place id.
 * @param data - Status and failure fields.
 * @returns `Lead.id`.
 */
const addLead = async (placeId: string, data: LeadState): Promise<string> => {
  const { id } = await prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId,
      name: 'Fictional Clinic',
      rawPlace: {},
      graphClaimedAt: new Date(),
      ...data,
    },
  });
  return id;
};

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_leads_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  ({ id: campaignId } = await prisma.campaign.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      nicheProfileId: niche.id,
      city: 'Lahore',
      areas: ['DHA'],
      searchCount: 4,
      status: 'SCORING',
    },
  }));
  app = await startServer(testEnv({ DATABASE_URL: url }), 0);
  const address = app.getServer()?.address();
  if (address === null || address === undefined || typeof address === 'string') {
    throw new Error('API server is not listening on a TCP port');
  }
  baseUrl = `http://127.0.0.1:${String(address.port)}`;
}, 120_000);

afterAll(async () => {
  await app.close();
  await app.getContainer().resolve(PrismaProvider).$disconnect();
  await prisma.$disconnect();
});

// Proves FR-32's retry: back to the failed step's status, failure and claim cleared, only once.
describe('POST /leads/:id/retry', () => {
  it('re-queues a lead failed at labelling as ENRICHED and clears its failure', async () => {
    const id = await addLead('fictional-retry-label', {
      status: 'FAILED',
      failedStep: 'LABEL_REVIEWS',
      error: 'Review labelling failed',
    });

    const response = await retry(id);

    expect(response).toEqual({ status: 200, body: { id, status: 'ENRICHED' } });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id } })).toMatchObject({
      status: 'ENRICHED',
      failedStep: null,
      error: null,
      graphClaimedAt: null,
    });
  });

  it('re-queues a lead failed at the website as DISCOVERED', async () => {
    const id = await addLead('fictional-retry-website', {
      status: 'FAILED',
      failedStep: 'ENRICH_WEBSITE',
      error: 'Unexpected Error in this step',
    });

    expect((await retry(id)).body).toEqual({ id, status: 'DISCOVERED' });
  });

  it('refuses a second retry and a lead that is not FAILED with 409', async () => {
    const failed = await addLead('fictional-retry-twice', {
      status: 'FAILED',
      failedStep: 'SCORE',
    });
    const scored = await addLead('fictional-retry-scored', { status: 'SCORED' });
    await retry(failed);

    expect((await retry(failed)).status).toBe(409);
    expect((await retry(scored)).status).toBe(409);
    expect((await prisma.lead.findUniqueOrThrow({ where: { id: scored } })).status).toBe('SCORED');
  });

  it('answers 404 for an unknown lead and 400 for an id that is too long', async () => {
    expect((await retry('fictional-missing-lead')).status).toBe(404);
    expect((await retry('x'.repeat(65))).status).toBe(400);
  });
});

// Proves FR-30's lead detail: facts, signals with ids, reviews without authors, the Solution as stored.
describe('GET /leads/:id', () => {
  const detail = async (id: string) => {
    const response = await fetch(`${baseUrl}/leads/${id}`);
    return { status: response.status, text: await response.text() };
  };

  it('returns a picked lead with its signals, reviews newest first, and the Solution', async () => {
    const id = await addLead('fictional-detail-pick', { status: 'SCORED' });
    await prisma.lead.update({
      where: { id },
      data: {
        status: 'READY_TO_CALL',
        score: 61,
        tier: 'WARM',
        rating: 4.5,
        scoreBreakdown: { pain: 25, fit: 16, reachability: 20, abilityToPay: 0 },
      },
    });
    const signal = await prisma.signal.create({
      data: {
        leadId: id,
        dimension: 'PAIN',
        key: 'phone_unanswered_reviews',
        points: 15,
        evidence: '2 of 3 reviews',
      },
    });
    await prisma.review.createMany({
      data: [
        {
          leadId: id,
          author: 'Fictional Reviewer',
          text: 'Older',
          rating: 2,
          publishedAt: new Date('2026-10-01T09:00:00Z'),
        },
        {
          leadId: id,
          author: 'Fictional Reviewer',
          text: 'Newer',
          rating: 1,
          publishedAt: new Date('2026-11-01T09:00:00Z'),
          labels: ['PHONE_UNANSWERED'],
        },
      ],
    });
    const service = await prisma.service.findFirstOrThrow({ orderBy: { slug: 'asc' } });
    await prisma.solution.create({
      data: {
        leadId: id,
        serviceId: service.id,
        reason: 'Fictional reason.',
        signalIds: [signal.id],
        model: 'claude-haiku-5-5',
      },
    });

    const response = await detail(id);
    const body = LeadDetail.parse(JSON.parse(response.text));

    expect(response.status).toBe(200);
    expect(response.text).not.toContain('Fictional Reviewer');
    expect(response.text).not.toContain('author');
    expect(body).toMatchObject({
      id,
      campaignId,
      status: 'READY_TO_CALL',
      tier: 'WARM',
      rating: 4.5,
    });
    expect(body.signals).toEqual([
      {
        id: signal.id,
        key: 'phone_unanswered_reviews',
        dimension: 'PAIN',
        points: 15,
        evidence: '2 of 3 reviews',
        sourceUrl: null,
      },
    ]);
    expect(body.reviews.map((review) => [review.text, review.publishedAt, review.labels])).toEqual([
      ['Newer', '2026-11-01T09:00:00.000Z', ['PHONE_UNANSWERED']],
      ['Older', '2026-10-01T09:00:00.000Z', []],
    ]);
    expect(body.solution).toEqual({
      serviceSlug: service.slug,
      serviceName: service.name,
      reason: 'Fictional reason.',
      model: 'claude-haiku-5-5',
      signalIds: [signal.id],
    });
  });

  it('passes a cited signal id that no longer exists through unchanged', async () => {
    const id = await addLead('fictional-detail-stale', { status: 'SCORED' });
    const service = await prisma.service.findFirstOrThrow({ orderBy: { slug: 'asc' } });
    await prisma.solution.create({
      data: {
        leadId: id,
        serviceId: service.id,
        reason: 'Fictional reason.',
        signalIds: ['fictional-deleted-signal'],
        model: 'claude-haiku-5-5',
      },
    });

    const body = LeadDetail.parse(JSON.parse((await detail(id)).text));

    expect(body.signals).toEqual([]);
    expect(body.solution?.signalIds).toEqual(['fictional-deleted-signal']);
  });

  it('returns no Solution for an exit status, and the filter reason of a FILTERED_OUT lead', async () => {
    const exit = await addLead('fictional-detail-exit', { status: 'SCORED' });
    await prisma.lead.update({ where: { id: exit }, data: { status: 'NO_STRONG_SIGNAL' } });
    const filtered = await addLead('fictional-detail-filtered', { status: 'SCORED' });
    await prisma.lead.update({
      where: { id: filtered },
      data: { status: 'FILTERED_OUT', filterReason: 'Fictional filter reason' },
    });

    expect(LeadDetail.parse(JSON.parse((await detail(exit)).text))).toMatchObject({
      status: 'NO_STRONG_SIGNAL',
      solution: null,
    });
    expect(LeadDetail.parse(JSON.parse((await detail(filtered)).text))).toMatchObject({
      status: 'FILTERED_OUT',
      filterReason: 'Fictional filter reason',
    });
  });

  it('answers 404 for an unknown lead and 400 for an id that is too long', async () => {
    expect((await detail('fictional-missing-lead')).status).toBe(404);
    expect((await detail('x'.repeat(65))).status).toBe(400);
  });
});
