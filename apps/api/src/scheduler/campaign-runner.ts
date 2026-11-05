/**
 * The campaign-runner loop: every 10 s, claims one DISCOVERING campaign and runs discover on it.
 *
 * Serves: FR-3, NFR-1, NFR-2, docs/architecture.md §9, issue #10.
 * Used by: apps/api/src/worker.ts, apps/api/test/campaign-runner.int.spec.ts.
 */
import type { HazelApp } from '@hazeljs/core';
import { errorFields, type Logger } from '../logging/logger.js';
import { discoverCampaign, type DiscoverDeps } from '../pipeline/discover.step.js';

const RUNNER_INTERVAL_MS = 10_000;
// Must outlast one search, which the claim is renewed before: the Apify adapter's 11-minute wait.
const DISCOVERY_LEASE_MS = 15 * 60 * 1000;
// A start is one request, so this is generous, and it fits HazelJS's 30-second shutdown limit.
const START_SAVE_WAIT_MS = 10_000;

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
 * @returns A function that stops the loop and refuses new paid starts, then waits up to the given
 * milliseconds for a start in progress; it resolves false when that wait ran out.
 */
export function startCampaignRunner(
  deps: DiscoverDeps,
  intervalMs = RUNNER_INTERVAL_MS,
): (waitMs: number) => Promise<boolean> {
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
  return (waitMs) => {
    stopped = true;
    clearTimeout(timer);
    return deps.startGate.close(waitMs);
  };
}

/**
 * Adds the shutdown handler that stops the runner.
 *
 * Call it before `registerPrismaShutdown`: handlers run in order, and the run id needs the database.
 * Does not wait for a pass to finish: a collect can wait 11 minutes, and it is free to repeat, so
 * the process ends and the next worker reads that run once the lease runs out.
 * @param app - The worker's app.
 * @param stop - From {@link startCampaignRunner}.
 * @param logger - Told when a start outlasted the wait.
 */
export function registerRunnerShutdown(
  app: Pick<HazelApp, 'registerShutdownHandler'>,
  stop: (waitMs: number) => Promise<boolean>,
  logger: Pick<Logger, 'warn'>,
): void {
  app.registerShutdownHandler({
    name: 'campaign-runner',
    handler: async () => {
      if (await stop(START_SAVE_WAIT_MS)) return;
      logger.warn('a paid start outlasted the shutdown wait; the next pass pauses on its record');
    },
    timeout: START_SAVE_WAIT_MS + 1000,
  });
}
