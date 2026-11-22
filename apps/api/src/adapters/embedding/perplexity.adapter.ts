/**
 * The real embedder: one Perplexity embeddings request per batch, Zod-checked, int8 answers
 * decoded to unit vectors.
 *
 * Serves: FR-16, ADR-0006 (pplx-embed-v1-0.6b, 1024 dimensions), ADR-0007, NFR-4; issue #17.
 * API: https://docs.perplexity.ai/api-reference/embeddings-post
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=false.
 */
import { Inject, Injectable } from '@hazeljs/core';
import { z } from 'zod';
import { ENV, type Env } from '../../config/env.js';
import { Prisma } from '../../generated/prisma/client.js';
import {
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
  type EmbeddingPort,
  type EmbeddingResult,
} from '../../ports/embedding.port.js';
import { toUnitVector } from './unit-vector.js';

// The API's limit per request.
const MAX_TEXTS = 512;
// A batch of short service texts answers in about a second; past this the request is dropped.
const TIMEOUT_MS = 30_000;

// Only the fields used; the API sends more (object, model, prompt_tokens, input_cost).
const EmbeddingsResponse = z.object({
  data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.string() })),
  usage: z.object({
    total_tokens: z.number().int().nonnegative(),
    cost: z.object({ total_cost: z.number().nonnegative() }),
  }),
});

// base64_int8: one signed byte per dimension.
const decodeInt8 = (base64: string): Int8Array => {
  const bytes = Buffer.from(base64, 'base64');
  return new Int8Array(bytes.buffer, bytes.byteOffset, bytes.length);
};

// A 200 that is unusable may still have been billed.
const unexpectedShape = (): EmbeddingError =>
  new EmbeddingError('Embeddings API answer has an unexpected shape', true);

/** Embeds texts with Perplexity's embeddings API. */
@Injectable()
export class PerplexityEmbeddingAdapter implements EmbeddingPort {
  /** The API root; a spec points it at a local stub so no test can reach the network. */
  protected readonly baseUrl: string = 'https://api.perplexity.ai';
  /** How long one request may take, in milliseconds. */
  protected readonly timeoutMs: number = TIMEOUT_MS;
  private readonly apiKey: string;
  private readonly model: string;

  /**
   * Wires the adapter to its key and model.
   * @param env - Parsed configuration; `loadEnv` guarantees PERPLEXITY_API_KEY when
   * DEMO_MODE=false, and PERPLEXITY_EMBEDDING_MODEL has a default.
   */
  constructor(@Inject(ENV) env: Env) {
    // Never empty in practice: `loadEnv` refuses to start without it when DEMO_MODE=false.
    this.apiKey = env.PERPLEXITY_API_KEY ?? '';
    this.model = env.PERPLEXITY_EMBEDDING_MODEL;
  }

  /**
   * Sends one request for all texts and decodes the answer.
   *
   * Does not retry: the docs do not say which failures are unbilled, and the seed re-embeds
   * whatever is still missing on its next run.
   * @inheritDoc
   * @throws EmbeddingError for no texts or more than 512, an HTTP error, a timeout, a dropped
   * connection, or an answer that is not JSON, not the embeddings shape, or missing a vector; its
   * `maybeBilled` says whether the request may have been billed.
   */
  async embed(texts: string[]): Promise<EmbeddingResult> {
    if (texts.length === 0 || texts.length > MAX_TEXTS) {
      throw new EmbeddingError(`Embed 1 to ${String(MAX_TEXTS)} texts per request`, false);
    }
    const parsed = EmbeddingsResponse.safeParse(await this.post(texts));
    // Not parsed.error: a Zod message may quote the response.
    if (!parsed.success) throw unexpectedShape();
    const { data, usage } = parsed.data;
    const vectors = texts.map((_, index) => {
      const item = data.find((candidate) => candidate.index === index);
      const values = item === undefined ? null : decodeInt8(item.embedding);
      if (values?.length !== EMBEDDING_DIMENSIONS) throw unexpectedShape();
      return toUnitVector(values);
    });
    return {
      vectors,
      tokens: usage.total_tokens,
      costUsd: new Prisma.Decimal(usage.cost.total_cost),
    };
  }

  private async post(texts: string[]): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}/v1/embeddings`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: texts,
          // Fixed, so a larger model is shortened to fit `vector(1024)` instead of failing the write.
          dimensions: EMBEDDING_DIMENSIONS,
          encoding_format: 'base64_int8',
        }),
        signal,
      });
    } catch {
      // Either way the request may have reached Perplexity before it went wrong.
      throw new EmbeddingError(
        signal.aborted ? 'Embeddings API timed out' : 'Embeddings API connection failed',
        true,
      );
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new EmbeddingError(
        `Embeddings API refused the request: HTTP ${String(response.status)}`,
        false,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new EmbeddingError('Embeddings API answer was unreadable or timed out', true);
    }
  }
}
