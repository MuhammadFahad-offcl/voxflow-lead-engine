/**
 * Integration tests of `POST /leads/:id/retry` over HTTP on a test database: a FAILED lead is
 * re-queued from its failed step, once; anything else is refused with the right status code.
 *
 * Serves: FR-32 (retry button); issue #15 acceptance ("given a failed lead, when retry is
 * triggered, then it runs again from the failed step").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
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
