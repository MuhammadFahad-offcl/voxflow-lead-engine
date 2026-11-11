/**
 * Demo-mode test of review labelling: every fictional demo clinic's reviews, stored the way pass 2
 * stores them, are labelled by the fake LLM from the answers `pnpm llm:record` saved, through the
 * real gate. Fails when a recording is missing or the prompt changed without recording again.
 *
 * Serves: FR-13, FR-36 (demo mode with recorded LLM responses), ADR-0007; issue #13 acceptance
 * ("labelling fixtures for the demo clinics exist", "works with DEMO_MODE=true").
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { ScraperlinkReviewsItem } from '../src/adapters/lead-source/apify-items.js';
import { FakeLlmAdapter } from '../src/adapters/llm/fake.adapter.js';
import { DiscoveryRepository } from '../src/db/discovery.repository.js';
import { LlmSpendRepository } from '../src/db/llm-spend.repository.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { ReviewLabelRepository } from '../src/db/review-label.repository.js';
import { ReviewRepository } from '../src/db/review.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { LlmService } from '../src/llm/llm.service.js';
import type { Logger } from '../src/logging/logger.js';
import { labelReviews } from '../src/pipeline/label-reviews.step.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

const REPO = resolve(import.meta.dirname, '../../..');

let prisma: PrismaProvider;
let campaignId = '';
let demo: ScraperlinkReviewsItem[] = [];
const logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn() } as unknown as Logger;

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_label_demo_test');
  prisma = new PrismaProvider(testEnv({ DATABASE_URL: url }));
  await seed(prisma, resolve(REPO, 'config'));
  const niche = await prisma.nicheProfile.findFirstOrThrow();
  ({ id: campaignId } = await prisma.campaign.create({
    data: { organizationId: SEED_ORGANIZATION_ID, nicheProfileId: niche.id, city: 'Lahore' },
  }));
  const raw = await readFile(resolve(REPO, 'fixtures/reviews/dental-lahore.json'), 'utf8');
  demo = z.array(ScraperlinkReviewsItem).parse(JSON.parse(raw));
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves the demo has a recorded answer for every clinic, and the answers fit the real schema.
describe('labelReviews in demo mode', () => {
  it('labels every review of every demo clinic from the recordings, with costs', async () => {
    const reviews = new ReviewRepository(prisma, new DiscoveryRepository(prisma));
    const deps = {
      reviews: new ReviewLabelRepository(prisma),
      llm: new LlmService(new LlmSpendRepository(prisma), new FakeLlmAdapter(), logger),
      logger,
    };

    for (const item of demo) {
      const lead = await prisma.lead.create({
        data: {
          organizationId: SEED_ORGANIZATION_ID,
          campaignId,
          placeId: item.placeId,
          name: 'Fictional demo clinic',
          rawPlace: {},
          status: 'ENRICHED',
        },
      });
      await reviews.saveReviews(lead.id, item.reviews);

      const outcome = await labelReviews(deps, lead.id);

      expect({ place: item.placeId, outcome }).toEqual({
        place: item.placeId,
        outcome: { status: 'LABELLED', reviews: item.reviews.length },
      });
    }
    const unlabelled = await prisma.review.count({ where: { labels: { isEmpty: true } } });
    expect(unlabelled).toBe(0);
    // Every clinic with text made one recorded call, priced from its recorded usage.
    const withText = demo.filter((item) => item.reviews.some((review) => review.text?.trim()));
    expect(await prisma.costRecord.count({ where: { service: 'LLM' } })).toBe(withText.length);
  });
});
