/**
 * The port that turns texts into vectors for the service catalog's similarity search.
 *
 * Serves: FR-16 (catalog search), ADR-0006 (pplx-embed-v1-0.6b, 1024 dimensions), ADR-0007; issue #17.
 * Used by: apps/api/src/adapters/embedding/, apps/api/src/bootstrap.ts,
 * apps/api/src/pipeline/query-embedding.ts.
 */
import { Prisma } from '../generated/prisma/client.js';

/** DI token of {@link EmbeddingPort}. */
export const EMBEDDING = 'EmbeddingPort';

/** Length of every vector: the size of `Service.embedding` (`vector(1024)`). */
export const EMBEDDING_DIMENSIONS = 1024;

/**
 * What pplx-embed-v1-0.6b costs per token, in US dollars ($0.004 per million, ADR-0006). The real
 * adapter reads each request's cost from Perplexity; this prices a worst case before a request.
 */
export const EMBEDDING_USD_PER_TOKEN = new Prisma.Decimal('0.004').dividedBy(1_000_000);

/** Most texts one {@link EmbeddingPort.embed} call takes: Perplexity's limit per request. */
export const EMBEDDING_MAX_TEXTS = 512;

/**
 * A failed embedding request. The message is a fixed phrase, optionally with an HTTP status, never
 * a response body, key or input text, so it is safe to log.
 */
export class EmbeddingError extends Error {
  /**
   * Builds the error.
   * @param message - A fixed phrase.
   * @param maybeBilled - False only when the service is known not to have billed the request (it
   * was never sent, was refused, or was rate limited or failed upstream); true when it may have
   * been, as after a timeout, a dropped connection or a bad answer to a 200.
   */
  constructor(
    message: string,
    readonly maybeBilled: boolean,
  ) {
    super(message);
    this.name = 'EmbeddingError';
  }
}

/** What one {@link EmbeddingPort.embed} call returned. */
export interface EmbeddingResult {
  /** One unit-length vector of {@link EMBEDDING_DIMENSIONS} numbers per input text, in input order. */
  vectors: number[][];
  /** Tokens the request used; stored as the cost record's `units`. */
  tokens: number;
  /** What the request cost, in US dollars. */
  costUsd: Prisma.Decimal;
}

/** Embeds texts. Implemented by the Perplexity embeddings adapter and a fake. */
export interface EmbeddingPort {
  /**
   * Embeds up to 512 non-empty texts in one request.
   *
   * Does not record the cost: the caller writes the `CostRecord(PERPLEXITY_EMBEDDINGS)`.
   * @param texts - The texts, each with at least one word.
   * @returns The vectors in the same order as `texts`, the tokens used and the cost.
   * @throws EmbeddingError for no texts or more than {@link EMBEDDING_MAX_TEXTS}, or when the
   * request fails or the answer is not usable.
   */
  embed(texts: string[]): Promise<EmbeddingResult>;
}
