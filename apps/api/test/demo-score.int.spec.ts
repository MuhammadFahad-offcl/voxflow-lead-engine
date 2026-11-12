/**
 * Demo-mode test of the whole Cycle 1 pipeline so far, on the fictional DHA demo clinics, with every
 * fake adapter: discover, read the website, search the web context, store pass-2 reviews, label
 * them from the recorded LLM answers, then score. Pins each clinic's score and tier, so a change to
 * a rule, a weight or a fixture shows up here.
 *
 * Serves: FR-14, FR-15, FR-36 (demo mode); issue #14 acceptance ("works with DEMO_MODE=true",
 * "demo clinics get the scores listed in the PR").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import { FakeLeadSourceAdapter } from '../src/adapters/lead-source/fake.adapter.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { FakeWebContextAdapter } from '../src/adapters/web-context/fake.adapter.js';
import { FakeWebReaderAdapter } from '../src/adapters/web-reader/fake.adapter.js';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import { LeadContextRepository } from '../src/db/lead-context.repository.js';
import { LeadWebsiteRepository } from '../src/db/lead-website.repository.js';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { ReviewLabelRepository } from '../src/db/review-label.repository.js';
import { ReviewRepository } from '../src/db/review.repository.js';
import { ScoreRepository } from '../src/db/score.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { LlmService } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import { AREAS_DIR, loadAreaPolygons } from '../src/pipeline/area-polygons.js';
import { discoverCampaign } from '../src/pipeline/discover.step.js';
import { enrichContext } from '../src/pipeline/enrich-context.step.js';
import { enrichReviewsForCampaign } from '../src/pipeline/enrich-reviews.step.js';
import { enrichWebsite } from '../src/pipeline/enrich.step.js';
import { labelReviews } from '../src/pipeline/label-reviews.step.js';
import { PaidStartGate } from '../src/pipeline/paid-start-gate.js';
import { scoreStoredLead } from '../src/pipeline/score.step.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;
const logger = {
  info: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  debug: jest.fn(),
} as unknown as Logger;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_demo_score_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the demo pipeline scores every clinic that passed the filter, with stored evidence.
describe('demo pipeline: discover → enrich → reviews → labels → score', () => {
  it('scores the DHA demo clinics as listed in the #14 PR', async () => {
    const niche = await prisma.nicheProfile.findFirstOrThrow();
    const claimedAt = new Date();
    const { id: campaignId } = await prisma.campaign.create({
      data: {
        organizationId: SEED_ORGANIZATION_ID,
        nicheProfileId: niche.id,
        city: 'Lahore',
        areas: ['DHA'],
        searchCount: niche.searchTerms.length,
        discoveryClaimedAt: claimedAt,
      },
    });
    const leadSource = new FakeLeadSourceAdapter(logger);
    const discovery = new DiscoveryRepository(prisma);

    await expect(
      discoverCampaign(
        {
          repository: discovery,
          leadSource,
          polygons: loadAreaPolygons(AREAS_DIR),
          logger,
          now: () => new Date(),
          startGate: new PaidStartGate(),
        },
        { id: campaignId, claimedAt },
      ),
    ).resolves.toBe('ENRICHING');
    const passed = await prisma.lead.findMany({
      where: { campaignId, status: { not: 'FILTERED_OUT' } },
      orderBy: { placeId: 'asc' },
    });
    for (const lead of passed) {
      await enrichWebsite(
        { leads: new LeadWebsiteRepository(prisma), webReader: new FakeWebReaderAdapter(), logger },
        lead.id,
      );
      await enrichContext(
        {
          leads: new LeadContextRepository(prisma),
          webContext: new FakeWebContextAdapter(),
          logger,
          now: () => new Date(),
        },
        lead.id,
      );
    }
    await enrichReviewsForCampaign(
      { prisma, reviewRepo: new ReviewRepository(prisma, discovery), leadSource, logger },
      campaignId,
    );
    const llm = new LlmService(new LlmSpendRepository(prisma), new FakeLlmAdapter(), logger);
    const scores: Record<string, string> = {};
    for (const lead of passed) {
      // A missing recording shows here, not only as a changed score below.
      const labelled = await labelReviews(
        { reviews: new ReviewLabelRepository(prisma), llm, logger },
        lead.id,
      );
      expect({ place: lead.placeId, status: labelled.status }).toEqual({
        place: lead.placeId,
        status: 'LABELLED',
      });
      const outcome = await scoreStoredLead(
        { leads: new ScoreRepository(prisma), logger },
        lead.id,
      );
      scores[lead.placeId] =
        outcome.status === 'SCORED' ? `${String(outcome.score)} ${outcome.tier}` : 'skipped';
    }

    // Listed with their top evidence lines in the #14 score-step PR, then lowered by 7 for every
    // clinic that had reviews_unreplied: the demo clinics store fewer than the 10 reviews it needs.
    // p04 and p05 are filtered out.
    expect(scores).toEqual({
      'fictional-place-p01': '67 WARM',
      'fictional-place-p02': '35 COLD',
      'fictional-place-p03': '47 WARM',
      'fictional-place-p06': '69 WARM',
      'fictional-place-p07': '59 WARM',
      'fictional-place-p08': '32 COLD',
      'fictional-place-p09': '42 COLD',
      'fictional-place-p10': '45 WARM',
      'fictional-place-p11': '52 WARM',
    });
    // Every point of every stored score is a stored signal (FR-14).
    const stored = await prisma.lead.findMany({
      where: { campaignId, status: 'SCORED' },
      include: { signals: true },
    });
    for (const lead of stored) {
      const points = lead.signals.reduce((sum, signal) => sum + signal.points, 0);
      expect({ place: lead.placeId, points }).toEqual({ place: lead.placeId, points: lead.score });
    }
    // p08 stores one review: the signal is kept with 0 points and says why (founder, after #14).
    const p08 = stored.find((lead) => lead.placeId === 'fictional-place-p08');
    expect(p08?.signals.find((signal) => signal.key === 'reviews_unreplied')).toMatchObject({
      points: 0,
      evidence: 'Only 1 review stored, fewer than the 10 needed',
    });
    // The whole pipeline for nine clinics: Jest's 5-second default is too short under full-suite load.
  }, 60_000);
});
