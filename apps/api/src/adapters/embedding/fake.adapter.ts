/**
 * The fake embedder: a bag-of-words hasher instead of the network. Deterministic (same text, same
 * vector), and texts that share words score closer, so demo-mode catalog search is meaningful.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake), FR-16, FR-36, NFR-9; issue #17.
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=true; tests.
 */
import { Injectable } from '@hazeljs/core';
import { Prisma } from '../../generated/prisma/client.js';
import {
  EMBEDDING_DIMENSIONS,
  EMBEDDING_MAX_TEXTS,
  EmbeddingError,
  type EmbeddingPort,
  type EmbeddingResult,
} from '../../ports/embedding.port.js';
import { toUnitVector } from './unit-vector.js';

// pplx-embed-v1-0.6b's rate, $0.004 per million tokens, so demo costs have the right size.
const USD_PER_TOKEN = new Prisma.Decimal('0.004').dividedBy(1_000_000);
// Letters and digits in any script. Urdu diacritics (zer, zabar) split a word; still deterministic.
const WORD = /[\p{L}\p{N}]+/gu;

// FNV-1a, 32-bit: a fixed, well-spread hash, so a word always lands in the same dimension.
const hashWord = (word: string): number => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < word.length; index += 1) {
    hash = Math.imul(hash ^ word.charCodeAt(index), 0x01000193);
  }
  return hash >>> 0;
};

const wordsOf = (text: string): string[] => text.toLowerCase().match(WORD) ?? [];

// Adds 1 to a word's hashed dimension per occurrence, then scales the counts to unit length.
const countWords = (words: string[]): number[] => {
  const counts = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  for (const word of words) {
    const dimension = hashWord(word) % EMBEDDING_DIMENSIONS;
    counts[dimension] = (counts[dimension] ?? 0) + 1;
  }
  return toUnitVector(counts);
};

/** Embeds texts by counting their words into hashed dimensions. */
@Injectable()
export class FakeEmbeddingAdapter implements EmbeddingPort {
  /**
   * Lowercases each text, splits it into words, adds 1 to the word's hashed dimension per
   * occurrence, then scales the counts to unit length. One token per word.
   * @inheritDoc
   * @throws EmbeddingError for no texts or more than 512, or when a text has no words.
   */
  embed(texts: string[]): Promise<EmbeddingResult> {
    // Runs inside then(), so a bad text rejects the promise like the real adapter, never throws.
    return Promise.resolve().then(() => {
      // The real adapter's limits, so a caller bug fails in demo mode and tests too.
      if (texts.length === 0 || texts.length > EMBEDDING_MAX_TEXTS) {
        throw new EmbeddingError(
          `Embed 1 to ${String(EMBEDDING_MAX_TEXTS)} texts per request`,
          false,
        );
      }
      const wordLists = texts.map(wordsOf);
      if (wordLists.some((words) => words.length === 0)) {
        throw new EmbeddingError('Cannot embed a text with no words', false);
      }
      const tokens = wordLists.reduce((sum, words) => sum + words.length, 0);
      return { vectors: wordLists.map(countWords), tokens, costUsd: USD_PER_TOKEN.times(tokens) };
    });
  }
}
