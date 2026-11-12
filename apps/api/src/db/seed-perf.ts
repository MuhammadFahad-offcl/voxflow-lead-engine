/**
 * The performance seed: one campaign of fictional leads, scored, with their signals, so the lead
 * table can be timed against NFR-3 (pages load within 2 seconds with 5,000 leads stored).
 *
 * Every lead is fictional (`fictional-perf-*`, no phone) and finished: SCORED, FAILED or
 * FILTERED_OUT, so the worker never claims, enriches or pays for any of them. Each score is the sum
 * of its signals' points, as the score step guarantees (docs/database.md, Lead score).
 *
 * Serves: NFR-3, FR-30; issue #16 (prompt C1-14: `pnpm seed:perf`).
 * Used by: apps/api/src/seed-perf.ts, apps/api/test/seed-perf.int.spec.ts.
 */
import type { PrismaClient } from '../generated/prisma/client.js';
import { SEED_ORGANIZATION_ID } from './seed.js';

const PLACE_PREFIX = 'fictional-perf-';
const AREAS = ['DHA', 'Gulberg', 'Model Town', 'Johar Town', 'Bahria Town'];
// The dental-clinic thresholds (niche file `tiers`).
const HOT = 70;
const WARM = 45;

/** What a run of the performance seed did. */
export interface PerfSeedResult {
  campaignId: string;
  /** False when the leads were already there, so nothing was written. */
  added: boolean;
  leads: number;
}

const placeId = (n: number): string => `${PLACE_PREFIX}${String(n).padStart(5, '0')}`;

const tierOf = (score: number): 'HOT' | 'WARM' | 'COLD' => {
  if (score >= HOT) return 'HOT';
  return score >= WARM ? 'WARM' : 'COLD';
};

/**
 * Splits a score over three signals, one each in pain, fit and reachability.
 * @param score - 0 to 100.
 * @returns The three point values, adding up to the score.
 */
const split = (score: number): [number, number, number] => {
  const pain = Math.min(40, Math.round(score * 0.45));
  const fit = Math.min(25, Math.round((score - pain) * 0.55));
  return [pain, fit, score - pain - fit];
};

/**
 * Adds the performance campaign and its leads, unless they are already stored.
 *
 * Does not touch any other campaign or lead: every row it writes is new and fictional.
 * Does not seed the organization or niche: run `pnpm db:seed` first.
 * @param prisma - Client connected to the database to fill.
 * @param count - How many leads, e.g. 5000.
 * @returns The campaign id, whether this run wrote anything, and the lead count.
 * @throws Prisma's not-found error when the database is not seeded; Prisma errors from the writes.
 */
export async function seedPerfCampaign(
  prisma: PrismaClient,
  count: number,
): Promise<PerfSeedResult> {
  const existing = await prisma.lead.findFirst({
    where: { organizationId: SEED_ORGANIZATION_ID, placeId: placeId(1) },
    select: { campaignId: true },
  });
  if (existing !== null) {
    const leads = await prisma.lead.count({ where: { campaignId: existing.campaignId } });
    return { campaignId: existing.campaignId, added: false, leads };
  }
  const niche = await prisma.nicheProfile.findFirstOrThrow({
    where: { organizationId: SEED_ORGANIZATION_ID },
    orderBy: { version: 'desc' },
  });
  const { id: campaignId } = await prisma.campaign.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      nicheProfileId: niche.id,
      city: 'Lahore',
      areas: AREAS,
      searchCount: niche.searchTerms.length * AREAS.length,
      // Finished: the lead runner never claims its leads.
      status: 'SCORING',
      foundCount: count,
    },
  });

  const leads = Array.from({ length: count }, (_, index) => {
    const n = index + 1;
    const base = {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId: placeId(n),
      name: `Fictional Perf Clinic ${String(n).padStart(5, '0')}`,
      area: AREAS[n % AREAS.length] ?? null,
      reviewCount: (n * 13) % 400,
      rawPlace: {},
    };
    if (n % 50 === 0) {
      return {
        ...base,
        status: 'FAILED' as const,
        failedStep: 'LABEL_REVIEWS',
        error: 'Review labelling failed',
      };
    }
    if (n % 20 === 0)
      return { ...base, status: 'FILTERED_OUT' as const, filterReason: 'Fictional' };
    const score = (n * 37) % 101;
    const [pain, fit, reachability] = split(score);
    return {
      ...base,
      status: 'SCORED' as const,
      score,
      tier: tierOf(score),
      scoreBreakdown: { pain, fit, reachability, abilityToPay: 0 },
    };
  });
  await prisma.lead.createMany({ data: leads });

  const scored = await prisma.lead.findMany({
    where: { campaignId, status: 'SCORED' },
    select: { id: true, score: true },
  });
  const signals = scored.flatMap(({ id, score }) => {
    const [pain, fit, reachability] = split(score ?? 0);
    return [
      {
        leadId: id,
        key: 'phone_unanswered_reviews',
        dimension: 'PAIN' as const,
        points: pain,
        evidence: 'Fictional: 2 of the last 30 reviews say the phone goes unanswered',
      },
      {
        leadId: id,
        key: 'category_match',
        dimension: 'FIT' as const,
        points: fit,
        evidence: 'Fictional: Maps category Dental clinic',
      },
      {
        leadId: id,
        key: 'mobile_number',
        dimension: 'REACHABILITY' as const,
        points: reachability,
        evidence: 'Fictional: listing phone is a mobile number',
      },
    ];
  });
  await prisma.signal.createMany({ data: signals });
  return { campaignId, added: true, leads: count };
}
