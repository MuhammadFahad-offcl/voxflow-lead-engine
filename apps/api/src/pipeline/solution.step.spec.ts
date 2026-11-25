/**
 * Unit tests of the SOLUTION step: what it stores for each agent outcome, that the agent gets the
 * lead's own ids, that a cap pauses it and that it never runs for a lead that is done.
 *
 * Serves: FR-17, FR-33, NFR-4 (cost per lead); issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { SolutionOutcome } from '../agents/solution.agent.js';
import type { StoredOutcome, StoredSolutionLead } from '../db/solution.repository.js';
import { Prisma, type LeadStatus } from '../generated/prisma/client.js';
import { SpendCapReachedError } from '../llm/llm.service.js';
import type { Logger } from '../logging/logger.js';
import { solveLead, type SolutionStepDeps } from './solution.step.js';

const logger = { info: jest.fn(), warn: jest.fn() } as unknown as Logger;
const costUsd = new Prisma.Decimal('0.0005');
const lead: StoredSolutionLead = {
  organizationId: 'org_voxflow',
  campaignId: 'campaign_1',
  leadId: 'lead_1',
  name: 'Fictional Dental',
  area: 'DHA',
  tier: 'WARM',
  score: 52,
  signals: [
    { id: 's1', key: 'booking_wait_reviews', dimension: 'PAIN', points: 12, evidence: '…' },
  ],
};

// A step whose agent answers `outcome` (or throws it); records what was stored. `stores: false`
// is a save that found the lead already done (an overlapping run).
const stepWith = (
  outcome: SolutionOutcome | Error,
  read: { status?: LeadStatus; solved?: boolean; tier?: string } = {},
  stores = true,
) => {
  const saved: StoredOutcome[] = [];
  const solve = jest.fn<SolutionStepDeps['solve']>(() =>
    outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome),
  );
  const deps: SolutionStepDeps = {
    solutions: {
      forSolution: () =>
        Promise.resolve({
          ...lead,
          tier: read.tier ?? lead.tier,
          status: read.status ?? 'SCORED',
          solved: read.solved ?? false,
        }),
      saveOutcome: (_lead, stored) => {
        saved.push(stored);
        return Promise.resolve(stores);
      },
    },
    solve,
    logger,
  };
  return { deps, saved, solve };
};

// Proves the step stores exactly the agent's outcome, with the lead's own ids on every call.
describe('solveLead', () => {
  it('gives the agent the lead’s own lead and campaign ids, so every cost record names them', async () => {
    const { deps, solve } = stepWith({ kind: 'noStrongSignal', reason: 'r', model: 'm', costUsd });

    await solveLead(deps, 'lead_1');

    expect(solve).toHaveBeenCalledWith(
      expect.objectContaining({ leadId: 'lead_1', campaignId: 'campaign_1' }),
    );
  });

  it('stores a pick as a Solution with its model', async () => {
    const pick = {
      kind: 'pick' as const,
      serviceSlug: 'whatsapp-booking-assistant',
      reason: 'Patients wait to book.',
      signalKeys: ['booking_wait_reviews'],
      model: 'claude-haiku-5-5',
      costUsd,
    };
    const { deps, saved } = stepWith(pick);

    await expect(solveLead(deps, 'lead_1')).resolves.toEqual({
      status: 'SOLVED',
      serviceSlug: 'whatsapp-booking-assistant',
    });
    expect(saved).toEqual([
      {
        kind: 'pick',
        serviceSlug: 'whatsapp-booking-assistant',
        reason: 'Patients wait to book.',
        signalKeys: ['booking_wait_reviews'],
        model: 'claude-haiku-5-5',
      },
    ]);
  });

  it.each<[string, SolutionOutcome, string]>([
    [
      'no strong signal',
      { kind: 'noStrongSignal', reason: 'r', model: 'm', costUsd },
      'NO_STRONG_SIGNAL',
    ],
    ['needs review', { kind: 'needsReview', problems: ['p'], costUsd }, 'NEEDS_REVIEW'],
  ])('ends the lead with its exit status for %s', async (_what, outcome, status) => {
    const { deps, saved } = stepWith(outcome);

    await expect(solveLead(deps, 'lead_1')).resolves.toEqual({ status });
    expect(saved).toEqual([{ kind: 'exit', status }]);
  });

  it('runs the agent for a HOT lead too', async () => {
    const { deps, solve } = stepWith(
      { kind: 'noStrongSignal', reason: 'r', model: 'm', costUsd },
      { tier: 'HOT' },
    );

    await expect(solveLead(deps, 'lead_1')).resolves.toEqual({ status: 'NO_STRONG_SIGNAL' });
    expect(solve).toHaveBeenCalledTimes(1);
  });

  it.each<[string, SolutionOutcome, string]>([
    [
      'pick',
      { kind: 'pick', serviceSlug: 's', reason: 'r', signalKeys: [], model: 'm', costUsd },
      'ALREADY_SOLVED',
    ],
    ['exit', { kind: 'noStrongSignal', reason: 'r', model: 'm', costUsd }, 'NOT_ELIGIBLE'],
  ])(
    'reports a skip when an overlapping run stored the %s first',
    async (_what, outcome, reason) => {
      const { deps } = stepWith(outcome, {}, false);

      await expect(solveLead(deps, 'lead_1')).resolves.toEqual({ status: 'SKIPPED', reason });
    },
  );

  it('pauses on a reached spend cap and stores nothing', async () => {
    const { deps, saved } = stepWith(new SpendCapReachedError('LLM monthly cap reached'));

    await expect(solveLead(deps, 'lead_1')).resolves.toEqual({
      status: 'CAP_REACHED',
      reason: 'LLM monthly cap reached',
    });
    expect(saved).toEqual([]);
  });

  it('lets any other error through, so the graph fails the lead (FR-32)', async () => {
    const { deps, saved } = stepWith(new Error('Fictional outage'));

    await expect(solveLead(deps, 'lead_1')).rejects.toThrow('Fictional outage');
    expect(saved).toEqual([]);
  });

  it.each<[string, Parameters<typeof stepWith>[1], string]>([
    ['already has a Solution', { solved: true }, 'ALREADY_SOLVED'],
    ['has left SCORED', { status: 'NO_STRONG_SIGNAL' }, 'NOT_ELIGIBLE'],
    ['is COLD', { tier: 'COLD' }, 'NOT_ELIGIBLE'],
  ])('skips a lead that %s, without calling the agent', async (_what, read, reason) => {
    const { deps, solve } = stepWith(new Error('must not run'), read);

    await expect(solveLead(deps, 'lead_1')).resolves.toEqual({ status: 'SKIPPED', reason });
    expect(solve).not.toHaveBeenCalled();
  });
});
