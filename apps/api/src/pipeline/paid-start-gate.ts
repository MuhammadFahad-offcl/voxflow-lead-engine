/**
 * Lets shutdown wait for the short stretch from a run's reservation to its saved run id.
 *
 * Serves: FR-33, NFR-1, NFR-2; issue #10 (a signal must not strand a paid run with no saved id).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/scheduler/campaign-runner.ts,
 * apps/api/src/worker.ts.
 */
import { setTimeout as sleep } from 'node:timers/promises';

/** Tracks the start-and-save section of one worker; a worker runs one pass at a time. */
export class PaidStartGate {
  private closed = false;
  private section: Promise<unknown> | null = null;

  /**
   * Runs one start-and-save section, unless shutdown has begun.
   * @param section - Reserves, starts the paid run and saves its id.
   * @returns What the section returned, or CLOSED when it was refused and nothing ran.
   * @throws What the section throws.
   */
  async run<T>(section: () => Promise<T>): Promise<T | 'CLOSED'> {
    if (this.closed) return 'CLOSED';
    const running = section();
    this.section = running;
    try {
      return await running;
    } finally {
      this.section = null;
    }
  }

  /**
   * Refuses new sections and waits for the one in progress.
   *
   * Does not cancel it: past the wait, a section cut off by the process ending leaves a record with
   * no run id, and the next pass pauses on that record instead of paying again.
   * @param waitMs - The longest to wait, in milliseconds.
   * @returns True when no section is running any more; false when the wait ran out.
   */
  async close(waitMs: number): Promise<boolean> {
    this.closed = true;
    if (this.section === null) return true;
    const timer = new AbortController();
    const finished = this.section.then(
      () => true,
      () => true,
    );
    const timedOut = sleep(waitMs, false, { signal: timer.signal }).catch(() => false);
    const result = await Promise.race([finished, timedOut]);
    timer.abort();
    return result;
  }
}
