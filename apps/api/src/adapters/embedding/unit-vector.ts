/**
 * Scales a vector to unit length, the form both embedding adapters return.
 *
 * Serves: FR-16, ADR-0006; issue #17.
 * Used by: apps/api/src/adapters/embedding/fake.adapter.ts, apps/api/src/adapters/embedding/perplexity.adapter.ts.
 */
import { EmbeddingError } from '../../ports/embedding.port.js';

/**
 * Divides every component by the vector's length.
 *
 * Does not change the direction, so cosine distances are the same before and after.
 * @param values - The raw components (counts, or int8 values from Perplexity).
 * @returns A new array of length 1.
 * @throws EmbeddingError when every component is 0: such a vector has no direction to compare.
 */
export function toUnitVector(values: ArrayLike<number>): number[] {
  const components = Array.from(values);
  const length = Math.hypot(...components);
  if (length === 0) throw new EmbeddingError('Embedding is all zeros', false);
  return components.map((value) => value / length);
}
