/**
 * The campaign-runner loop: every 10 s, claims one DISCOVERING campaign and runs discover on it.
 *
 * Serves: FR-3, NFR-1, NFR-2, docs/architecture.md §9, issue #10.
 * Used by: apps/api/src/worker.ts, apps/api/test/campaign-runner.int.spec.ts.
 */
import { errorFields } from '../logging/logger.js';
import { discoverCampaign, type DiscoverDeps } from '../pipeline/discover.step.js';

const RUNNER_INTERVAL_MS = 10_000;
// Must outlast one search, which the claim is renewed before: the Apify adapter's 11-minute wait.
const DISCOVERY_LEASE_MS = 15 * 60 * 1000;

/**
 * Runs one pass: claims at most one campaign and discovers it.
 *
 * Does not catch errors: `discoverCampaign` pauses its campaign on any it can, so what reaches here
 * means the database refused even the pause. {@link startCampaignRunner} logs it; the claim left
 * behind expires with its lease, and the next pass carries on from the campaign's cost records.
 * @param deps - What the discover step needs.
 * @returns True when a campaign was claimed; false when there was nothing to do.
 * @throws What `discoverCampaign` throws.
 */
export async function runCampaignRunnerOnce(deps: DiscoverDeps): Promise<boolean> {
  const claim = await deps.repository.claimNext(deps.now(), DISCOVERY_LEASE_MS);
  if (claim === null) return false;
  const result = await discoverCampaign(deps, claim);
  deps.logger.info({ campaignId: claim.id, result }, 'discover pass finished');
  return true;
}

/**
 * Starts the loop.
 *
 * Waits for a pass to end before timing the next, so one process never overlaps itself.
 * Does not stop on an error: one bad campaign must not end the worker.
 * @param deps - What the discover step needs.
 * @param intervalMs - Pause between passes, in milliseconds.
 * @returns A function that stops the loop after the current pass.
 */
export function startCampaignRunner(
  deps: DiscoverDeps,
  intervalMs = RUNNER_INTERVAL_MS,
): () => void {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const tick = async (): Promise<void> => {
    try {
      await runCampaignRunnerOnce(deps);
    } catch (error) {
      deps.logger.error(errorFields(error), 'campaign runner pass failed');
    }
    if (!stopped) timer = setTimeout(() => void tick(), intervalMs);
  };
  timer = setTimeout(() => void tick(), 0);
  return () => {
    stopped = true;
    clearTimeout(timer);
  };
}
