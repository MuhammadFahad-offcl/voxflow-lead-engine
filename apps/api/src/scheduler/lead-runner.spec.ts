/**
 * Unit tests of the lead-runner loop and its shutdown, with stub dependencies (no database): a
 * failing pass never ends the loop, stopping ends it, and shutdown waits for a paid start to save
 * its run id.
 *
 * Serves: NFR-1 (one bad pass must not end the worker), NFR-2 (shutdown keeps a paid start
 * findable); T-1 audit.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it, jest } from '@jest/globals';
import type { HazelApp } from '@hazeljs/core';
import type { Logger } from '../logging/logger.js';
import { PaidStartGate } from '../pipeline/paid-start-gate.js';
import { registerLeadRunnerShutdown, startLeadRunner, type LeadRunnerDeps } from './lead-runner.js';

const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

/**
 * Stub dependencies: no campaign to review, no lead to claim, nothing to finish, unless a test
 * replaces `enrichingCampaigns`.
 * @param enrichingCampaigns - What the pass's first read returns, or throws.
 * @returns Dependencies whose unused parts are never called.
 */
const stubDeps = (enrichingCampaigns: () => Promise<string[]>): LeadRunnerDeps =>
  ({
    leads: {
      enrichingCampaigns,
      claimReviews: () => Promise.resolve(null),
      releaseReviews: () => Promise.resolve(),
      claimNext: () => Promise.resolve([]),
      finishEnrichment: () => Promise.resolve([]),
      pauseEnrichment: () => Promise.resolve(),
    },
    startGate: new PaidStartGate(),
    logger: logger as unknown as Logger,
    now: () => new Date(),
    concurrency: 3,
  }) as unknown as LeadRunnerDeps;

// Proves NFR-1: a pass that throws is logged and the next pass still runs; stop ends the loop.
describe('startLeadRunner', () => {
  it('keeps passing after a failed pass, and stops passing once stopped', async () => {
    let calls = 0;
    const deps = stubDeps(() => {
      calls += 1;
      return calls === 1
        ? Promise.reject(new Error('Fictional database blip'))
        : Promise.resolve([]);
    });

    const stop = startLeadRunner(deps, 5);
    for (let wait = 0; calls < 3 && wait < 200; wait += 1) await sleep(5);
    await stop(10);
    const atStop = calls;
    await sleep(50);

    expect(atStop).toBeGreaterThanOrEqual(3);
    expect(calls).toBe(atStop);
    expect(logger.error).toHaveBeenCalledWith(
      { errorName: 'Error', errorCode: null },
      'lead runner pass failed',
    );
  });
});

// Proves NFR-2: shutdown refuses a new paid start and waits for one in flight, and says so when the
// wait runs out.
describe('registerLeadRunnerShutdown', () => {
  it('waits for the stop and warns when a paid start outlasted the wait', async () => {
    type Handler = Parameters<HazelApp['registerShutdownHandler']>[0];
    const handlers: Handler[] = [];
    const app: Pick<HazelApp, 'registerShutdownHandler'> = {
      registerShutdownHandler: (handler) => {
        handlers.push(handler);
      },
    };
    const stop = jest.fn((waitMs: number) => Promise.resolve(waitMs < 0));

    registerLeadRunnerShutdown(app, stop, logger);
    await handlers[0]?.handler();

    expect(stop).toHaveBeenCalledWith(10_000);
    expect(handlers[0]?.timeout).toBe(11_000);
    expect(logger.warn).toHaveBeenCalledWith(
      'a reviews step outlasted the shutdown wait; its campaign may pause for a check',
    );
  });

  it('refuses a new paid start once stopped, and waits for the one in flight', async () => {
    const gate = new PaidStartGate();
    let release: () => void = () => undefined;
    const inFlight = gate.run(
      () =>
        new Promise<string>((done) => {
          release = () => {
            done('run-1');
          };
        }),
    );

    const closing = gate.close(1000);
    const refused = await gate.run(() => Promise.resolve('run-2'));
    release();

    expect(refused).toBe('CLOSED');
    await expect(inFlight).resolves.toBe('run-1');
    await expect(closing).resolves.toBe(true);
  });
});
