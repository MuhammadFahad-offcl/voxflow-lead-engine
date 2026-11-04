/**
 * FR-3's campaign state machine as one pure function.
 *
 * Serves: FR-3 (campaign status), hazeljs-conventions ("pure functions for rules").
 * Used by: apps/api/src/modules/campaigns/campaigns.service.ts.
 */
import type { CampaignStatus } from '../../generated/prisma/client.js';

// The forward chain of FR-3, in order.
const FORWARD: readonly CampaignStatus[] = [
  'DISCOVERING',
  'ENRICHING',
  'SCORING',
  'SCRIPTING',
  'AWAITING_APPROVAL',
  'CALLING',
  'COMPLETED',
];

// Statuses with work still to do, so a campaign in one can be paused or fail. Not PAUSED (it is
// resumed instead), COMPLETED or FAILED (both are final).
const ACTIVE_STATUSES: readonly CampaignStatus[] = FORWARD.slice(0, -1);

const isActive = (status: CampaignStatus): boolean => ACTIVE_STATUSES.includes(status);

/**
 * Says whether a campaign may move from one status to another.
 *
 * Allowed: each status to the next one in FR-3's chain; any active status to PAUSED or FAILED;
 * PAUSED back to an active status (which one is the caller's job: `Campaign.pausedFrom`) or to
 * FAILED.
 * Does not allow skipping a step, going backwards, staying put, or leaving COMPLETED or FAILED.
 * @param from - The campaign's current status.
 * @param to - The status asked for.
 * @returns True when the move is allowed.
 */
export function canTransition(from: CampaignStatus, to: CampaignStatus): boolean {
  if (to === 'PAUSED' || to === 'FAILED')
    return isActive(from) || (from === 'PAUSED' && to === 'FAILED');
  if (from === 'PAUSED') return isActive(to);
  const index = FORWARD.indexOf(from);
  return index !== -1 && FORWARD[index + 1] === to;
}
