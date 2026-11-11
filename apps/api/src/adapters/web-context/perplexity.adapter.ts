/**
 * The real web context: one Perplexity Search API request per business, Zod-checked.
 *
 * Serves: FR-12, FR-33, NFR-4, ADR-0007; issue #12. API: https://docs.perplexity.ai/api-reference/search-post
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=false.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { setTimeout as sleep } from 'node:timers/promises';
import { ENV, type Env } from '../../config/env.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { LOGGER, type Logger } from '../../logging/logger.js';
import {
  WebContextError,
  type BusinessQuery,
  type WebContextPort,
  type WebContextResult,
} from '../../ports/web-context.port.js';
import {
  buildSearchQuery,
  SEARCH_REQUEST_USD,
  SearchResponse,
  toBusinessContext,
} from './search-results.js';

// Five results are all the summary keeps; the API's default is 10.
const MAX_RESULTS = 5;
// A search answers in a second or two; past this the request is dropped, not waited on.
const TIMEOUT_MS = 15_000;
// Perplexity does not bill 429 or 5xx answers, so only these are retried, twice.
const MAX_RETRIES = 2;
// Failures before the request left this machine: nothing was sent, so nothing was billed.
const NOT_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']);

// Read by shape, not instanceof: an error built in another realm (as under Jest) is not an Error here.
const errorCode = (error: unknown): string | null => {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : null;
};

/** Looks businesses up with Perplexity's Search API. */
@Injectable()
export class PerplexityWebContextAdapter implements WebContextPort {
  /** The API root; a spec points it at a local stub so no test can reach the network. */
  protected readonly baseUrl: string = 'https://api.perplexity.ai';
  /** How long one request may take, in milliseconds. */
  protected readonly timeoutMs: number = TIMEOUT_MS;
  /** The wait before the first retry, in milliseconds; each later retry waits twice as long. */
  protected readonly retryDelayMs: number = 1000;
  private readonly apiKey: string;

  /**
   * Wires the adapter to its key and logger.
   * @param env - Parsed configuration; `loadEnv` guarantees PERPLEXITY_API_KEY when
   * DEMO_MODE=false.
   * @param logger - Root logger.
   */
  constructor(
    @Inject(ENV) env: Env,
    @Inject(LOGGER) private readonly logger: Logger,
  ) {
    // Never empty in practice: `loadEnv` refuses to start without it when DEMO_MODE=false.
    this.apiKey = env.PERPLEXITY_API_KEY ?? '';
  }

  /** @inheritDoc */
  maxCostUsd(): Prisma.Decimal {
    return SEARCH_REQUEST_USD;
  }

  /**
   * Sends one search and maps the answer.
   *
   * Retries only a 429, a 5xx or a request that never left this machine: those are not billed. A
   * timeout, a dropped connection or a bad answer is thrown at once, because the request may
   * already have been billed and a retry would pay twice.
   * Logs attempt numbers and fixed reasons only: never the business, the query or result text.
   * @inheritDoc
   * @throws WebContextError for an HTTP error, a timeout, a dropped connection, an answer that is
   * not JSON or not the Search API shape, or retries used up; its `maybeBilled` says whether the
   * request may have been billed.
   */
  async getContext(query: BusinessQuery): Promise<WebContextResult> {
    const body = JSON.stringify({
      query: buildSearchQuery(query),
      max_results: MAX_RESULTS,
      search_type: 'web',
    });
    const json = await this.post(body);
    const parsed = SearchResponse.safeParse(json);
    // Not parsed.error: a Zod message may quote the response.
    if (!parsed.success)
      throw new WebContextError('Search API answer has an unexpected shape', true);
    return { context: toBusinessContext(parsed.data), costUsd: SEARCH_REQUEST_USD };
  }

  private async post(body: string): Promise<unknown> {
    for (let attempt = 1; ; attempt += 1) {
      const outcome = await this.send(body);
      if ('json' in outcome) return outcome.json;
      if (attempt > MAX_RETRIES) {
        throw new WebContextError(`Search API failed after retries: ${outcome.retry}`, false);
      }
      this.logger.warn({ attempt, reason: outcome.retry }, 'Perplexity search will be retried');
      await sleep(this.retryDelayMs * 2 ** (attempt - 1));
    }
  }

  private async send(body: string): Promise<{ json: unknown } | { retry: string }> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/search`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body,
        signal,
      });
    } catch (error) {
      if (NOT_SENT.has(errorCode(error) ?? '')) return { retry: 'connection refused' };
      // Either way the request may have reached Perplexity before it went wrong.
      throw new WebContextError(
        signal.aborted ? 'Search API timed out' : 'Search API connection failed',
        true,
      );
    }
    if (response.status === 429 || response.status >= 500) {
      await response.body?.cancel();
      return { retry: `HTTP ${String(response.status)}` };
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new WebContextError(
        `Search API refused the request: HTTP ${String(response.status)}`,
        false,
      );
    }
    try {
      return { json: await response.json() };
    } catch {
      throw new WebContextError('Search API answer was unreadable or timed out', true);
    }
  }
}
