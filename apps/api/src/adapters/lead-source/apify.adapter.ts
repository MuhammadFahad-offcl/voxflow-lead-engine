/**
 * The real lead source: Compass on Apify, started and read as two separate steps.
 *
 * Serves: FR-5, FR-33, ADR-0007, ADR-0015; issue #10 (never a second paid run for one search).
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=false.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { ApifyClient } from 'apify-client';
import { ENV, type Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { LOGGER, type Logger } from '../../logging/logger.js';
import type { CollectedRun, LeadSourcePort, PlaceSearch } from '../../ports/lead-source.port.js';
import { parsePlaceItems } from './apify-items.js';
import {
  assertChargeLimit,
  buildCompassInput,
  chargeOfRun,
  COMPASS_ACTOR_ID,
  runChargeLimitUsd,
} from './compass-input.js';

// Apify stops the run here. 100 places take about 3 minutes (31 s per 20 in the #9 spike), and the
// discover lease (15 minutes) must outlast this and the wait below.
const RUN_TIMEOUT_SECS = 600;
// The client backs off between attempts and retries network errors, 429 and 5xx.
const READ_RETRIES = 3;
const FINISHED = new Set(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);

/** Runs Compass on Apify. */
@Injectable()
export class ApifyLeadSourceAdapter implements LeadSourcePort {
  /** Apify's API root; a spec points it at a local stub so no test can reach the network. */
  protected readonly baseUrl: string = 'https://api.apify.com';
  /** How long {@link collect} waits, in seconds: the run's limit plus a minute for its shutdown. */
  protected readonly waitSecs: number = RUN_TIMEOUT_SECS + 60;
  private readonly token: string;

  /**
   * Wires the adapter to its token and logger.
   * @param env - Parsed configuration; `loadEnv` guarantees APIFY_TOKEN when DEMO_MODE=false.
   * @param logger - Root logger.
   */
  constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    this.token = env.APIFY_TOKEN ?? '';
  }

  /** @inheritDoc */
  chargeLimitUsd(maxResults: number): Prisma.Decimal {
    return runChargeLimitUsd(maxResults);
  }

  /**
   * Starts one Compass run with Apify's own charge limit on it.
   *
   * The client retries every request up to 8 times by default, POST included, so an unlucky start
   * could otherwise create 9 paid runs. This call uses a client with `maxRetries: 0`.
   * @inheritDoc
   */
  async start(search: PlaceSearch): Promise<string> {
    assertChargeLimit(search.chargeLimitUsd);
    const run = await this.client(0).actor(COMPASS_ACTOR_ID).start(buildCompassInput(search), {
      maxTotalChargeUsd: search.chargeLimitUsd.toNumber(),
      timeout: RUN_TIMEOUT_SECS,
    });
    return run.id;
  }

  /** @inheritDoc */
  async collect(runId: string): Promise<CollectedRun> {
    const client = this.client(READ_RETRIES);
    const run = await client.run(runId).waitForFinish({ waitSecs: this.waitSecs });
    if (!FINISHED.has(run.status)) {
      throw new Error(`Apify run ${runId} is still ${run.status} after the wait`);
    }
    if (run.status !== 'SUCCEEDED') {
      this.logger.warn({ runId, status: run.status }, 'Apify run did not succeed; keeping results');
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    return { items: parsePlaceItems(items, this.logger), costUsd: chargeOfRun(run) };
  }

  private client(maxRetries: number): ApifyClient {
    return new ApifyClient({ token: this.token, baseUrl: this.baseUrl, maxRetries });
  }
}
