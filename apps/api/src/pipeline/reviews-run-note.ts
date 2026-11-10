/**
 * The note of a pass-2 reviews run's `CostRecord`: what lets a restart find its paid run.
 *
 * Serves: FR-11, FR-33, ADR-0015; issue #12. Mirrors the search note of #10 in `search-plan.ts`.
 * Used by: apps/api/src/db/review.repository.ts, apps/api/src/pipeline/reviews-run-note.spec.ts.
 */
import { z } from 'zod';

const ReviewsRunNote = z.object({
  // Tells these records from discovery searches: `readSearchNote` needs a term and an area.
  kind: z.literal('pass2-reviews'),
  // Null from the reservation until Apify accepts the start: a crash in between leaves this trace.
  runId: z.string().nullable(),
  // OPEN: in use. ABANDONED: the founder checked Apify, so a new run may take its place.
  state: z.enum(['OPEN', 'ABANDONED']).default('OPEN'),
  placeCount: z.number().int().nonnegative(),
});
/** What a reviews run's `CostRecord.note` holds. */
export type ReviewsRunNote = z.infer<typeof ReviewsRunNote>;

/**
 * Writes the note of a reviews run's reservation.
 * @param note - Apify run id (null before the start) and how many places the run covers.
 * @returns The text for `CostRecord.note`.
 */
export function reviewsRunNote(note: Pick<ReviewsRunNote, 'runId' | 'placeCount'>): string {
  return JSON.stringify({ kind: 'pass2-reviews', ...note });
}

/**
 * Reads a `CostRecord.note` back.
 *
 * Does not throw: discovery records hold other notes.
 * @param note - The stored note.
 * @returns Run id, state and place count, or null when the record is not a reviews run.
 */
export function readReviewsRunNote(note: string | null): ReviewsRunNote | null {
  if (note === null) return null;
  try {
    return ReviewsRunNote.safeParse(JSON.parse(note)).data ?? null;
  } catch {
    return null;
  }
}
