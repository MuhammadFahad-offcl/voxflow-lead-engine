/**
 * The port the enrich step gets a business's web context through: one search per lead.
 *
 * Serves: FR-12, FR-33 (the Perplexity daily cap), ADR-0007; issue #12.
 * Used by: apps/api/src/adapters/web-context/ and apps/api/src/pipeline/enrich-context.step.ts.
 */
import type { BusinessContext } from '@voxflow/shared';
import type { Prisma } from '../generated/prisma/client.js';

/**
 * A failed lookup. The message is a fixed phrase, optionally with an HTTP status, never a response
 * body, key or query, so it is safe to log.
 */
export class WebContextError extends Error {
  /**
   * Builds the error.
   * @param message - A fixed phrase.
   * @param maybeBilled - False only when the service is known not to have billed the request
   * (it was never sent, was refused, or was rate limited or failed upstream); true when it may have
   * been, as after a timeout, a dropped connection or a bad answer to a 200.
   */
  constructor(
    message: string,
    readonly maybeBilled: boolean,
  ) {
    super(message);
    this.name = 'WebContextError';
  }
}

/** The business to look up. */
export interface BusinessQuery {
  name: string;
  /** Neighbourhood, e.g. "DHA Phase 5". */
  area: string;
  city: string;
  /** The normalized website URL, or null when the listing had none. */
  website: string | null;
}

/** What one lookup returned. */
export interface WebContextResult {
  context: BusinessContext;
  /** What the request cost, in US dollars. */
  costUsd: Prisma.Decimal;
}

/** Looks businesses up on the web. Implemented by the Perplexity Search adapter and a fake. */
export interface WebContextPort {
  /**
   * The most one {@link getContext} call can cost.
   * @returns US dollars; the step checks it against the daily cap before calling.
   */
  maxCostUsd(): Prisma.Decimal;

  /**
   * Runs one search for a business and shapes the excerpts into a context.
   *
   * Does not retry a call that may already have been billed.
   * @param query - The business to look up.
   * @returns The context (empty when nothing was found) and the cost of the request.
   * @throws When the service fails, times out or answers something that is not the expected shape.
   */
  getContext(query: BusinessQuery): Promise<WebContextResult>;
}
