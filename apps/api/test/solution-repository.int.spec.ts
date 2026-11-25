/**
 * Integration tests of `SolutionRepository.saveOutcome` on a test database: a pick becomes one
 * Solution citing the lead's own signal ids, a repeat adds nothing, and an exit status only ends a
 * SCORED lead that has no Solution.
 *
 * Serves: FR-17 (a pick cites the lead's signals; NO_STRONG_SIGNAL, NEEDS_REVIEW); issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { resolve } from 'node:path';
import { PrismaProvider } from '../src/db/prisma.provider.js';
import { seed, SEED_ORGANIZATION_ID } from '../src/db/seed.js';
import { SolutionRepository } from '../src/db/solution.repository.js';
import { createTestDatabase } from './test-database.js';
import { testEnv } from './test-env.js';

let prisma: PrismaProvider;
let solutions: SolutionRepository;
let campaignId: string;

// A fictional WARM lead with two evidenced signals, read back as the solution step reads it.
const scoredLead = async (placeId: string, status: 'SCORED' | 'FAILED' = 'SCORED') => {
  const { id } = await prisma.lead.create({
    data: {
      organizationId: SEED_ORGANIZATION_ID,
      campaignId,
      placeId,
      name: 'Fictional Clinic',
      rawPlace: {},
      status,
      tier: 'WARM',
      score: 52,
      signals: {
        create: [
          { key: 'booking_wait_reviews', dimension: 'PAIN', points: 12, evidence: 'Fictional.' },
          { key: 'no_online_booking', dimension: 'PAIN', points: 8, evidence: 'Fictional.' },
        ],
      },
    },
  });
  return solutions.forSolution(id);
};

const pick = (signalKeys: string[], serviceSlug = 'whatsapp-booking-assistant') => ({
  kind: 'pick' as const,
  serviceSlug,
  reason: 'Patients wait to book.',
  signalKeys,
  model: 'claude-haiku-5-5',
});
const exit = { kind: 'exit' as const, status: 'NO_STRONG_SIGNAL' as const };
const statusOf = async (leadId: string) =>
  (await prisma.lead.findUniqueOrThrow({ where: { id: leadId } })).status;

// `migrate deploy` starts a process and can download the schema engine on a fresh machine.
beforeAll(async () => {
  prisma = new PrismaProvider(
    testEnv({ DATABASE_URL: await createTestDatabase('voxflow_solution_repository_test') }),
  );
  await seed(prisma, resolve(import.meta.dirname, '../../../config'));
  solutions = new SolutionRepository(prisma);
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
}, 120_000);

afterAll(async () => {
  await prisma.$disconnect();
});

// Proves FR-17's storage rules: one Solution per lead, citing only the lead's own signals by id.
describe('SolutionRepository.saveOutcome', () => {
  it('stores a pick with the cited signals’ ids, and a repeat adds nothing', async () => {
    const lead = await scoredLead('fictional-save-pick');

    await expect(solutions.saveOutcome(lead, pick(['no_online_booking']))).resolves.toBe(true);
    await expect(solutions.saveOutcome(lead, pick(['booking_wait_reviews']))).resolves.toBe(false);

    const stored = await prisma.solution.findMany({
      where: { leadId: lead.leadId },
      include: { service: true },
    });
    const cited = lead.signals.find(({ key }) => key === 'no_online_booking');
    expect(stored.map(({ service, signalIds, model }) => [service.slug, signalIds, model])).toEqual(
      [['whatsapp-booking-assistant', [cited?.id], 'claude-haiku-5-5']],
    );
    // A pick leaves the lead SCORED: its script comes next (#20).
    expect(await statusOf(lead.leadId)).toBe('SCORED');
  });

  it('ends only a SCORED lead with no Solution with an exit status', async () => {
    const open = await scoredLead('fictional-save-exit');
    const failed = await scoredLead('fictional-save-failed', 'FAILED');
    const solved = await scoredLead('fictional-save-solved');
    await solutions.saveOutcome(solved, pick(['booking_wait_reviews']));

    await expect(solutions.saveOutcome(open, exit)).resolves.toBe(true);
    await expect(solutions.saveOutcome(failed, exit)).resolves.toBe(false);
    await expect(solutions.saveOutcome(solved, exit)).resolves.toBe(false);

    expect(await statusOf(open.leadId)).toBe('NO_STRONG_SIGNAL');
    expect(await statusOf(failed.leadId)).toBe('FAILED');
    expect(await statusOf(solved.leadId)).toBe('SCORED');
  });

  it('refuses a key that is not the lead’s signal, or a slug not in its catalog', async () => {
    const lead = await scoredLead('fictional-save-invalid');

    await expect(solutions.saveOutcome(lead, pick(['invented_signal']))).rejects.toThrow(
      'Signal invented_signal is not on lead',
    );
    await expect(solutions.saveOutcome(lead, pick([], 'invented-service'))).rejects.toThrow();
    expect(await prisma.solution.count({ where: { leadId: lead.leadId } })).toBe(0);
  });
});
