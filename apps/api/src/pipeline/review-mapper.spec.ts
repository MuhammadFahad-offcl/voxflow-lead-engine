/**
 * Unit tests for review-mapper pure rules.
 *
 * Serves: FR-11, ADR-0015, testing-conventions.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { mapReviewsToRows, MAX_REVIEWS_PER_LEAD, type RawReviewInput } from './review-mapper.js';

const review = (reviewId: string, overrides: Partial<RawReviewInput> = {}): RawReviewInput => ({
  reviewId,
  text: 'Fictional review text',
  stars: 4,
  publishedAtDate: '2026-10-10T00:00:00.000Z',
  responseFromOwnerText: null,
  responseFromOwnerDate: null,
  language: 'en',
  originalLanguage: 'en',
  ...overrides,
});

// Proves the mapper keeps the 30 newest reviews, flags owner replies and never carries an author.
describe('review-mapper', () => {
  it('maps up to 30 reviews, sorted newest first', () => {
    const raw = Array.from({ length: 40 }, (_, i) =>
      review(`rev-${String(i)}`, {
        publishedAtDate: new Date(Date.UTC(2026, 0, i + 1)).toISOString(),
      }),
    );

    const rows = mapReviewsToRows('lead-1', raw);

    expect(rows).toHaveLength(MAX_REVIEWS_PER_LEAD);
    expect(rows[0]?.externalId).toBe('rev-39');
    expect(rows[0]?.author).toBeNull();
  });

  it('sets ownerReplied true only for a non-blank owner reply', () => {
    const raw = [
      review('r1', { responseFromOwnerText: 'Thank you!' }),
      review('r2', { responseFromOwnerText: '   ' }),
      review('r3'),
    ];

    const rows = mapReviewsToRows('lead-1', raw);

    expect(rows.map((row) => row.ownerReplied)).toEqual([true, false, false]);
  });

  it('keeps a star-only review with empty text', () => {
    const rows = mapReviewsToRows('lead-1', [review('star-only', { text: null, stars: 5 })]);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.text).toBe('');
    expect(rows[0]?.rating).toBe(5);
  });
});
