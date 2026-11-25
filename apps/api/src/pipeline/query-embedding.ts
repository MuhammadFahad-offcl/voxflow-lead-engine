/**
 * The solution agent's query embedding under the Perplexity daily cap: check the cap, embed, then
 * record the cost against the lead. The same check-then-record pattern as the web search step, on
 * the same cap (searches and embeddings together).
 *
 * Not a reservation: two leads embedding at once can each pass the check, so the day can end over
 * the cap by the worst case of the calls in flight (a fraction of a cent for embeddings).
 *
 * Serves: FR-33, NFR-4 (cost per lead), FR-16; issue #19.
 * Used by: apps/api/src/agents/solution.agent.ts (createCatalogSearch), query-embedding.spec.ts.
 */
import type { LeadContextRepository } from '../db/lead-context.repository.js';
import { toStoredUsd } from '../db/stored-usd.js';
import type { Prisma } from '../generated/prisma/client.js';
import { SpendCapReachedError } from '../llm/llm.service.js';
import {
  EMBEDDING_USD_PER_TOKEN,
  EmbeddingError,
  type EmbeddingPort,
  type EmbeddingResult,
} from '../ports/embedding.port.js';
import { karachiDayStart, wouldPassCap } from './spend-cap.js';

// Tokens a request may add around the text (start and end markers): headroom for the worst case.
const EXTRA_TOKENS = 16;

/** Whose spend a query embedding is; null ids for a run with no lead or campaign. */
interface SpendOwner {
  organizationId: string;
  campaignId: string | null;
  leadId: string | null;
}

/** Where a query embedding's cap is read and its cost recorded. */
export interface QueryEmbeddingSpend {
  leads: Pick<LeadContextRepository, 'dailyCap' | 'recordEmbedding'>;
  /** The clock: which Asia/Karachi day the cap counts. */
  now: () => Date;
}

/**
 * The most embedding `text` can cost: a token is at least one byte of UTF-8, plus headroom.
 * @param text - The query text.
 * @returns The worst case in US dollars, rounded up as it would be stored.
 */
const queryEmbeddingMaxUsd = (text: string): Prisma.Decimal =>
  toStoredUsd(EMBEDDING_USD_PER_TOKEN.times(Buffer.byteLength(text, 'utf8') + EXTRA_TOKENS));

/**
 * Embeds one query for a lead, unless its worst case could take today's Perplexity spend past the
 * cap; records what it cost against the lead and its campaign.
 *
 * A failure known not to be billed records nothing; any other records the worst case, as the web
 * search step does.
 * @param deps - The cap and cost records, the clock and the bound embedder.
 * @param text - The query; the lead's strongest evidence.
 * @param lead - Whose spend it is.
 * @returns The embedder's result.
 * @throws SpendCapReachedError, before any request, when the embedding could pass the cap; the
 * embedder's errors, after recording a possibly billed one; Prisma or Zod errors from reading the
 * cap or writing the cost record.
 */
export async function embedWithinCap(
  deps: QueryEmbeddingSpend & { embedder: EmbeddingPort },
  text: string,
  lead: SpendOwner,
): Promise<EmbeddingResult> {
  const { leads, now, embedder } = deps;
  const owner = {
    organizationId: lead.organizationId,
    campaignId: lead.campaignId,
    leadId: lead.leadId,
  };
  const maxUsd = queryEmbeddingMaxUsd(text);
  const { capUsd, spentUsd } = await leads.dailyCap(lead.organizationId, karachiDayStart(now()));
  if (wouldPassCap(spentUsd, maxUsd, capUsd)) {
    // The search step's 3 decimals for the day's totals; 5 for the embedding, a fraction of a cent.
    const [spent, cap] = [spentUsd, capUsd].map((usd) => usd.toFixed(3));
    const next = maxUsd.toFixed(5);
    throw new SpendCapReachedError(
      `Perplexity daily cap: $${String(spent)} spent today, the next query embedding may cost $${next}, the cap is $${String(cap)}`,
    );
  }
  let result: EmbeddingResult;
  try {
    result = await embedder.embed([text]);
  } catch (error) {
    if (!(error instanceof EmbeddingError) || error.maybeBilled) {
      await leads.recordEmbedding(owner, maxUsd, 0);
    }
    throw error;
  }
  await leads.recordEmbedding(owner, toStoredUsd(result.costUsd), result.tokens);
  return result;
}
