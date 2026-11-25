/**
 * Unit tests of the solution agent's query embedding under the Perplexity daily cap: check, embed,
 * record against the lead; refuse before a call that could pass the cap.
 *
 * Serves: FR-33, NFR-4; issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { Prisma } from '../generated/prisma/client.js';
import { SpendCapReachedError } from '../llm/llm.service.js';
import { EmbeddingError, type EmbeddingPort } from '../ports/embedding.port.js';
import { embedWithinCap, type QueryEmbeddingSpend } from './query-embedding.js';

const lead = { organizationId: 'org_voxflow', campaignId: 'campaign_1', leadId: 'lead_1' };
const owner = lead;
const text = 'Patients say the phone is never answered.';

// A cap of `capUsd` with `spentUsd` spent today; records what is written; an embedder answering
// `result` (or throwing it).
const setup = (spentUsd: string, capUsd: string, result: Error | null = null) => {
  const recorded: unknown[][] = [];
  const days: Date[] = [];
  const leads: QueryEmbeddingSpend['leads'] = {
    dailyCap: (_organizationId, since) => {
      days.push(since);
      return Promise.resolve({
        capUsd: new Prisma.Decimal(capUsd),
        spentUsd: new Prisma.Decimal(spentUsd),
      });
    },
    recordEmbedding: (...args) => {
      recorded.push(args);
      return Promise.resolve();
    },
  };
  const embed = jest.fn<EmbeddingPort['embed']>(() =>
    result === null
      ? Promise.resolve({
          vectors: [[1]],
          tokens: 9,
          costUsd: new Prisma.Decimal('0.000000036'),
        })
      : Promise.reject(result),
  );
  const deps = { leads, now: () => new Date('2026-11-23T08:00:00Z'), embedder: { embed } };
  return { deps, recorded, embed, days };
};

// Proves FR-33 for query embeddings: they count on the Perplexity cap and are recorded per lead.
describe('embedWithinCap', () => {
  it('embeds and records the cost, rounded up for storage, against the lead and campaign', async () => {
    const { deps, recorded, embed, days } = setup('1.00', '2.00');

    await embedWithinCap(deps, text, lead);

    // 08:00 UTC on the 23rd is 13:00 in Karachi; its day began at 19:00 UTC on the 22nd.
    expect(days).toEqual([new Date('2026-11-22T19:00:00Z')]);
    expect(embed).toHaveBeenCalledWith([text]);
    expect(recorded.map(([who, usd, tokens]) => [who, String(usd), tokens])).toEqual([
      [owner, '0.00001', 9],
    ]);
  });

  it('refuses before the request when the embedding could pass the cap, and records nothing', async () => {
    const { deps, recorded, embed } = setup('2.00', '2.00');

    const refused = embedWithinCap(deps, text, lead);

    await expect(refused).rejects.toThrow(SpendCapReachedError);
    await expect(refused).rejects.toThrow(
      'Perplexity daily cap: $2.00000 spent today, the next query embedding may cost $0.00001, the cap is $2.00000',
    );
    expect(embed).not.toHaveBeenCalled();
    expect(recorded).toEqual([]);
  });

  it('records the worst case for a failure that may have been billed, then throws', async () => {
    const { deps, recorded } = setup('0', '2.00', new EmbeddingError('Timed out', true));

    await expect(embedWithinCap(deps, text, lead)).rejects.toThrow('Timed out');
    expect(recorded.map(([who, usd, tokens]) => [who, String(usd), tokens])).toEqual([
      [owner, '0.00001', 0],
    ]);
  });

  it('treats an error it does not know as possibly billed', async () => {
    const { deps, recorded } = setup('0', '2.00', new TypeError('fetch failed'));

    await expect(embedWithinCap(deps, text, lead)).rejects.toThrow('fetch failed');
    expect(recorded.map(([, usd]) => String(usd))).toEqual(['0.00001']);
  });

  it('records nothing for a failure known not to be billed', async () => {
    const { deps, recorded } = setup('0', '2.00', new EmbeddingError('Refused (401)', false));

    await expect(embedWithinCap(deps, text, lead)).rejects.toThrow('Refused');
    expect(recorded).toEqual([]);
  });
});
