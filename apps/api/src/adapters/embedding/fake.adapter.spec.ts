/**
 * Adapter tests of the fake embedder: the bag-of-words hasher that demo mode and tests search with.
 *
 * Serves: FR-16, ADR-0007, FR-36; issue #17.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { EMBEDDING_DIMENSIONS, EmbeddingError } from '../../ports/embedding.port.js';
import { FakeEmbeddingAdapter } from './fake.adapter.js';

const adapter = new FakeEmbeddingAdapter();

const cosine = (a: number[], b: number[]): number =>
  a.reduce((sum, value, index) => sum + value * (b[index] ?? 0), 0);

const embedOne = async (text: string): Promise<number[]> => {
  const [vector] = (await adapter.embed([text])).vectors;
  if (vector === undefined) throw new Error('no vector');
  return vector;
};

// Proves the fake is deterministic, unit length and word-based, so demo search is stable and meaningful.
describe('FakeEmbeddingAdapter', () => {
  it('gives the same vector for the same text on every call', async () => {
    const text = 'Patients call and nobody picks up';

    expect(await embedOne(text)).toEqual(await embedOne(text));
  });

  it('gives one unit-length vector of 1024 numbers per text, in input order', async () => {
    const { vectors } = await adapter.embed(['missed calls', 'google reviews']);

    expect(vectors).toHaveLength(2);
    for (const vector of vectors) {
      expect(vector).toHaveLength(EMBEDDING_DIMENSIONS);
      expect(cosine(vector, vector)).toBeCloseTo(1, 10);
    }
    expect(vectors[0]).toEqual(await embedOne('missed calls'));
  });

  it('ignores case and punctuation', async () => {
    expect(await embedOne('Missed CALLS, again!')).toEqual(await embedOne('missed calls again'));
  });

  it('scores texts that share words closer than texts that share none', async () => {
    const query = await embedOne('nobody answers the phone calls');
    const sharing = await embedOne('patients call and nobody answers the phone');
    const unrelated = await embedOne('google reviews have no reply');

    expect(cosine(query, sharing)).toBeGreaterThan(cosine(query, unrelated));
  });

  it('counts one token per word and prices them at the pplx-embed-v1-0.6b rate', async () => {
    const { tokens, costUsd } = await adapter.embed(['missed calls', 'google reviews reply']);

    expect(tokens).toBe(5);
    // $0.004 per million tokens.
    expect(costUsd.toString()).toBe('2e-8');
  });

  it('refuses a text with no words', async () => {
    await expect(adapter.embed(['  ...  '])).rejects.toThrow(EmbeddingError);
  });

  it('refuses no texts, or more than 512, like the real adapter', async () => {
    await expect(adapter.embed([])).rejects.toThrow(EmbeddingError);
    await expect(adapter.embed(new Array<string>(513).fill('word'))).rejects.toThrow(
      EmbeddingError,
    );
  });
});
