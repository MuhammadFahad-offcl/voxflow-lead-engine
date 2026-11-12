/**
 * Integration test of the score step on real Postgres: the score, breakdown, tier and status are
 * stored with one Signal row per scored signal, a re-score replaces them, the listing's booking
 * links come from the stored place item, and filtered-out leads are left alone.
 *
 * Serves: FR-14 (every point linked to a stored signal with evidence), FR-15; issue #14.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it, jest } from '@jest/globals';
import { resolve } from 'node:path';
import type { Prisma } from '../src/generated/prisma/client.js';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { ScoreRepository } from '../src/db/score.repository.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import type { Logger } from '../src/logging/logger.js';
import { scoreStoredLead } from '../src/pipeline/score.step.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;
let campaignId = '';
let place = 0;
const logger = { info: jest.fn() } as unknown as Logger;
const deps = () => ({ leads: new ScoreRepository(prisma), logger });
const page = 'https://p01.example.com/';

// A fictional lead read in full: a website without booking, no listing booking link, a mobile
// phone, a premium area, 120 reviews, and two reviews labelled PHONE_UNANSWERED.
const addLead = async (overrides: Partial<Prisma.LeadUncheckedCreateInput> = {}) => {
  place += 1;
  const lead = await prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId: `score-${String(place)}`,
      name: 'Fictional Clinic',
      rawPlace: { bookingLinks: [], reserveTableUrl: null },
      status: 'ENRICHED',
      category: 'Dental clinic',
      reviewCount: 120,
      area: 'DHA',
      phone: '+923000000001',
      phoneType: 'MOBILE',
      website: page,
      websiteStatus: 'READ_FETCH',
      hasOnlineBooking: false,
      websiteEvidence: {
        doctors: [],
        treatments: [],
        onlineBooking: [],
        chatWidgets: [],
        pagesRead: [page],
      },
      ...overrides,
    },
  });
  await prisma.review.createMany({
    data: ['Nobody answered the phone.', 'Phone koi nahi uthata.'].map((text, index) => ({
      leadId: lead.id,
      externalId: `fictional-${String(place)}-${String(index)}`,
      text,
      rating: 2,
      publishedAt: new Date(Date.UTC(2026, 9, 20 - index)),
      ownerReplied: true,
      labels: ['PHONE_UNANSWERED'],
    })),
  });
  return lead.id;
};
const signalsOf = (leadId: string) =>
  prisma.signal.findMany({ where: { leadId }, orderBy: { key: 'asc' } });

beforeAll(async () => {
  const url = await createTestDatabase('voxflow_score_test');
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

// Proves the stored score is the sum of the stored signals, each with its evidence, once each.
describe('scoreStoredLead', () => {
  it('stores score, breakdown, tier, SCORED and one signal row per scored signal', async () => {
    const leadId = await addLead();

    const outcome = await scoreStoredLead(deps(), leadId);

    // Pain 15 + 8, fit 10 + 7, reachability 12, ability to pay 5 + 5.
    expect(outcome).toEqual({ status: 'SCORED', score: 62, tier: 'WARM' });
    const lead = await prisma.lead.findUniqueOrThrow({ where: { id: leadId } });
    expect(lead).toMatchObject({ score: 62, tier: 'WARM', status: 'SCORED' });
    expect(lead.scoreBreakdown).toEqual({ pain: 23, fit: 17, reachability: 12, abilityToPay: 10 });
    const signals = await signalsOf(leadId);
    expect(signals.map((signal) => signal.key)).toEqual([
      'category_match',
      'many_reviews',
      'mobile_number',
      'no_online_booking',
      'phone_unanswered_reviews',
      'premium_area',
      // A 0-point note: the lead stores fewer than the 10 reviews this signal needs.
      'reviews_unreplied',
      'working_website',
    ]);
    expect(signals.reduce((sum, signal) => sum + signal.points, 0)).toBe(62);
    expect(signals.every((signal) => signal.evidence.trim() !== '')).toBe(true);
    const phone = signals.find((signal) => signal.key === 'phone_unanswered_reviews');
    const newest = await prisma.review.findFirstOrThrow({
      where: { leadId },
      orderBy: { publishedAt: 'desc' },
    });
    expect(phone).toMatchObject({ dimension: 'PAIN', points: 15, reviewId: newest.id });
  });

  it('replaces the signals and score when the lead is scored again', async () => {
    const leadId = await addLead();
    await scoreStoredLead(deps(), leadId);
    await prisma.lead.update({
      where: { id: leadId },
      data: { websiteStatus: 'UNREADABLE', hasOnlineBooking: null },
    });

    const outcome = await scoreStoredLead(deps(), leadId);

    // Loses no_online_booking (8) and working_website (5).
    expect(outcome).toEqual({ status: 'SCORED', score: 49, tier: 'WARM' });
    const keys = (await signalsOf(leadId)).map((signal) => signal.key);
    expect(keys).not.toContain('no_online_booking');
    expect(keys).not.toContain('working_website');
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives no booking points when the stored listing has a booking link', async () => {
    const leadId = await addLead({
      rawPlace: { bookingLinks: [{ name: 'Book', url: 'https://oladoc.example/x' }] },
    });

    await scoreStoredLead(deps(), leadId);

    expect((await signalsOf(leadId)).map((signal) => signal.key)).not.toContain(
      'no_online_booking',
    );
  });

  it('gives no booking points when the stored listing has a reserve link', async () => {
    const leadId = await addLead({
      rawPlace: { bookingLinks: [], reserveTableUrl: 'https://reserve.example/fictional' },
    });

    await scoreStoredLead(deps(), leadId);

    expect((await signalsOf(leadId)).map((signal) => signal.key)).not.toContain(
      'no_online_booking',
    );
  });

  it('throws on a malformed booking field instead of scoring it as not checked', async () => {
    const leadId = await addLead({ rawPlace: { bookingLinks: 'not a list' } });

    await expect(scoreStoredLead(deps(), leadId)).rejects.toThrow();
    expect(await signalsOf(leadId)).toHaveLength(0);
  });

  it('notes that the listing was not checked when the stored item has no booking field', async () => {
    const leadId = await addLead({ rawPlace: { title: 'Fictional Clinic' } });

    await scoreStoredLead(deps(), leadId);

    const booking = (await signalsOf(leadId)).find((signal) => signal.key === 'no_online_booking');
    expect(booking?.evidence).toBe(
      'Website read (READ_FETCH), no booking widget found; Maps listing not checked: actor gives no booking field',
    );
  });

  it('leaves a lead past scoring alone, so a retry never sends it back to SCORED', async () => {
    const leadId = await addLead({ status: 'READY_TO_CALL', score: 80, tier: 'HOT' });

    expect(await scoreStoredLead(deps(), leadId)).toEqual({
      status: 'SKIPPED',
      reason: 'PAST_SCORING',
    });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({
      score: 80,
      tier: 'HOT',
      status: 'READY_TO_CALL',
    });
    expect(await signalsOf(leadId)).toHaveLength(0);
  });

  it('scores a FAILED lead again', async () => {
    const leadId = await addLead({ status: 'FAILED' });

    expect(await scoreStoredLead(deps(), leadId)).toMatchObject({ status: 'SCORED' });
  });

  it('leaves a filtered-out lead unscored', async () => {
    const leadId = await addLead({ status: 'FILTERED_OUT' });

    expect(await scoreStoredLead(deps(), leadId)).toEqual({
      status: 'SKIPPED',
      reason: 'FILTERED_OUT',
    });
    expect(await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).toMatchObject({
      score: null,
      tier: null,
      status: 'FILTERED_OUT',
    });
  });
});
