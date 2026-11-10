/**
 * Unit tests of the reviews run note and its separation from the discovery search note.
 *
 * Serves: FR-33, issue #12 (pass-2 records must not look like pass-1 searches).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { readReviewsRunNote, reviewsRunNote } from './reviews-run-note.js';
import { readSearchNote, searchNote } from './search-plan.js';

// Proves discovery ignores pass-2 records, so a reviews run is never taken for a search to resume.
describe('reviewsRunNote', () => {
  it('is not a search note, so readSearchNote ignores it', () => {
    expect(readSearchNote(reviewsRunNote({ runId: 'run-1', placeCount: 3 }))).toBeNull();
    expect(readSearchNote(reviewsRunNote({ runId: null, placeCount: 3 }))).toBeNull();
  });

  it('reads back with its run id, an OPEN state and its place count', () => {
    const note = reviewsRunNote({ runId: null, placeCount: 3 });

    expect(readReviewsRunNote(note)).toEqual({
      kind: 'pass2-reviews',
      runId: null,
      state: 'OPEN',
      placeCount: 3,
    });
  });

  it('does not read a discovery search note, a missing note or text that is not JSON', () => {
    expect(
      readReviewsRunNote(searchNote({ term: 'dentist', area: 'DHA', runId: null })),
    ).toBeNull();
    expect(readReviewsRunNote(null)).toBeNull();
    expect(readReviewsRunNote('not json')).toBeNull();
  });
});
