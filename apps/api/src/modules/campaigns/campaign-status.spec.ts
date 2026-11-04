/**
 * Unit tests of the campaign state machine.
 *
 * Serves: FR-3.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { CampaignStatus } from '../../generated/prisma/client.js';
import { canTransition } from './campaign-status.js';

const ALL: CampaignStatus[] = [
  'DISCOVERING',
  'ENRICHING',
  'SCORING',
  'SCRIPTING',
  'AWAITING_APPROVAL',
  'CALLING',
  'COMPLETED',
  'PAUSED',
  'FAILED',
];

// Written out here, not imported, so a status dropped from the code's list fails this test.
const ACTIVE_STATUSES: CampaignStatus[] = [
  'DISCOVERING',
  'ENRICHING',
  'SCORING',
  'SCRIPTING',
  'AWAITING_APPROVAL',
  'CALLING',
];

const ALLOWED: [CampaignStatus, CampaignStatus][] = [
  ['DISCOVERING', 'ENRICHING'],
  ['ENRICHING', 'SCORING'],
  ['SCORING', 'SCRIPTING'],
  ['SCRIPTING', 'AWAITING_APPROVAL'],
  ['AWAITING_APPROVAL', 'CALLING'],
  ['CALLING', 'COMPLETED'],
  ...ACTIVE_STATUSES.map((status): [CampaignStatus, CampaignStatus] => [status, 'PAUSED']),
  ...ACTIVE_STATUSES.map((status): [CampaignStatus, CampaignStatus] => [status, 'FAILED']),
  ...ACTIVE_STATUSES.map((status): [CampaignStatus, CampaignStatus] => ['PAUSED', status]),
  ['PAUSED', 'FAILED'],
];
const isAllowed = (from: CampaignStatus, to: CampaignStatus) =>
  ALLOWED.some(([a, b]) => a === from && b === to);

// Proves canTransition allows exactly FR-3's moves and nothing else, for all 81 pairs.
describe('canTransition', () => {
  it.each(ALLOWED)('allows %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each([
    ['DISCOVERING', 'SCORING'],
    ['SCORING', 'ENRICHING'],
    ['CALLING', 'CALLING'],
    ['COMPLETED', 'PAUSED'],
    ['COMPLETED', 'DISCOVERING'],
    ['FAILED', 'DISCOVERING'],
    ['FAILED', 'PAUSED'],
    ['PAUSED', 'PAUSED'],
    ['PAUSED', 'COMPLETED'],
  ] as const)('refuses %s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('refuses every pair that is not in the allowed list', () => {
    const wrong = ALL.flatMap((from) => ALL.map((to) => [from, to] as const)).filter(
      ([from, to]) => canTransition(from, to) !== isAllowed(from, to),
    );

    expect(wrong).toEqual([]);
  });
});
