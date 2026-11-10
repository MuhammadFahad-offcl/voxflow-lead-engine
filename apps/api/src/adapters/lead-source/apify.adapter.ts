/**
 * The real lead source: Compass for places and Scraperlink for reviews on Apify.
 *
 * Serves: FR-5, FR-11, FR-33, ADR-0007, ADR-0015 (hybrid two-pass design).
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=false.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { ApifyClient } from 'apify-client';
import { ENV, type Env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import { LOGGER, type Logger } from '../../logging/logger.js';
import type {
  CollectedReviewsRun,
  CollectedRun,
  LeadSourcePort,
  PlaceSearch,
} from '../../ports/lead-source.port.js';
import { parsePlaceItems, parseReviewsItems } from './apify-items.js';
import {
  assertChargeLimit,
  buildCompassInput,
  chargeOfRun,
  COMPASS_ACTOR_ID,
  reviewsRunChargeLimitUsd,
  runChargeLimitUsd,
} from './compass-input.js';

/** Apify Store actor ID for Scraperlink Google Maps reviews scraper. */
const SCRAPERLINK_ACTOR_ID = 'scraperlink/google-maps-scraper';

// Apify stops the run here. 100 places take about 3 minutes (31 s per 20 in the #9 spike).
const RUN_TIMEOUT_SECS = 600;
// The longest one start request may take. The client's default is 360 s, and that plus collect's
// 660 s wait is 1,020 s, past the 15-minute lease; this leaves 210 s to read and store the results.
const START_TIMEOUT_SECS = 30;
// The client backs off between attempts and retries network errors, 429 and 5xx.
const READ_RETRIES = 3;
const FINISHED = new Set<string>(['SUCCEEDED', 'FAILED', 'TIMED-OUT', 'ABORTED']);
const isFinished = (status: string): status is CollectedRun['status'] => FINISHED.has(status);

/** Runs Compass (pass 1) and Scraperlink (pass 2) on Apify. */
@Injectable()
export class ApifyLeadSourceAdapter implements LeadSourcePort {
  /** Apify's API root; a spec points it at a local stub so no test can reach the network. */
  protected readonly baseUrl: string = 'https://api.apify.com';
  /** How long {@link collect} waits, in seconds: the run's limit plus a minute for its shutdown. */
  protected readonly waitSecs: number = RUN_TIMEOUT_SECS + 60;
  /** How long {@link start} waits for Apify's answer, in seconds. */
  protected readonly startTimeoutSecs: number = START_TIMEOUT_SECS;
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
   * Does not know whether a timed-out request created a run: it rejects like any failed start, so
   * the step keeps the reservation, retries nothing and asks the founder to check.
   * @inheritDoc
   */
  async start(search: PlaceSearch): Promise<string> {
    assertChargeLimit(search.chargeLimitUsd);
    const client = this.client(0, this.startTimeoutSecs);
    const run = await client.actor(COMPASS_ACTOR_ID).start(buildCompassInput(search), {
      maxTotalChargeUsd: search.chargeLimitUsd.toNumber(),
      // How long Apify lets the run go on, not how long this request may take.
      timeout: RUN_TIMEOUT_SECS,
    });
    return run.id;
  }

  /** @inheritDoc */
  async collect(runId: string): Promise<CollectedRun> {
    const client = this.client(READ_RETRIES);
    const run = await client.run(runId).waitForFinish({ waitSecs: this.waitSecs });
    if (!isFinished(run.status)) {
      throw new Error(`Apify run ${runId} is still ${run.status} after the wait`);
    }
    if (run.status !== 'SUCCEEDED') {
      this.logger.warn({ runId, status: run.status }, 'Apify run did not succeed; keeping results');
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    const places = parsePlaceItems(items, this.logger);
    return {
      items: places,
      costUsd: chargeOfRun(run),
      status: run.status,
      skippedCount: items.length - places.length,
    };
  }

  /** @inheritDoc */
  chargeLimitReviewsUsd(placeCount: number): Prisma.Decimal {
    return reviewsRunChargeLimitUsd(placeCount);
  }

  /** @inheritDoc */
  async startReviews(placeIds: readonly string[], chargeLimitUsd: Prisma.Decimal): Promise<string> {
    const client = this.client(0, this.startTimeoutSecs);
    const input = {
      placeIds: [...placeIds],
      reviews: true,
      maxReviews: 30,
      reviewsSort: 'newest',
    };
    const run = await client.actor(SCRAPERLINK_ACTOR_ID).start(input, {
      maxTotalChargeUsd: chargeLimitUsd.toNumber(),
      timeout: RUN_TIMEOUT_SECS,
    });
    return run.id;
  }

  /** @inheritDoc */
  async collectReviews(runId: string): Promise<CollectedReviewsRun> {
    const client = this.client(READ_RETRIES);
    const run = await client.run(runId).waitForFinish({ waitSecs: this.waitSecs });
    if (!isFinished(run.status)) {
      throw new Error(`Apify reviews run ${runId} is still ${run.status} after the wait`);
    }
    if (run.status !== 'SUCCEEDED') {
      this.logger.warn(
        { runId, status: run.status },
        'Apify reviews run did not succeed; keeping results',
      );
    }
    const { items } = await client.dataset(run.defaultDatasetId).listItems();
    const reviewItems = parseReviewsItems(items, this.logger);
    return {
      items: reviewItems,
      costUsd: chargeOfRun(run),
      status: run.status,
      skippedCount: items.length - reviewItems.length,
    };
  }

  private client(maxRetries: number, timeoutSecs?: number): ApifyClient {
    const { token, baseUrl } = this;
    return new ApifyClient({
      token,
      baseUrl,
      maxRetries,
      ...(timeoutSecs === undefined ? {} : { timeoutSecs }),
    });
  }
}
