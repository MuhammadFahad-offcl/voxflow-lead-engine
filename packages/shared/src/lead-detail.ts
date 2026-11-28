/**
 * The lead detail page's API shape, `GET /leads/:id`: one lead's facts, score, signals with their
 * ids, reviews (never their authors) and its Solution, if the solution agent picked one.
 *
 * Serves: FR-30 (lead detail), FR-14 (evidence per signal), FR-17 (the chosen service and the
 * signals it cites), FR-32 (status and error), US-5; issue #24.
 * Used by: apps/api/src/modules/leads/leads.service.ts, apps/api/test/leads.int.spec.ts.
 */
import { z } from 'zod';
import { LeadRow } from './leads.js';

// A lead-table signal plus its `Signal.id`, which `Solution.signalIds` cites.
const DetailSignal = LeadRow.shape.signals.element.extend({ id: z.string() });

/** One stored review. Has no author field: review authors never leave the database (CLAUDE.md). */
const LeadReview = z.object({
  id: z.string(),
  text: z.string(),
  rating: z.number().int().nullable(),
  /** ISO 8601 in UTC; the dashboard shows it in Asia/Karachi. */
  publishedAt: z.iso.datetime().nullable(),
  ownerReplied: z.boolean(),
  /** Niche review labels, e.g. "PHONE_UNANSWERED"; empty until labelled. */
  labels: z.array(z.string()),
});

/** The solution agent's pick for the lead. */
const LeadSolution = z.object({
  serviceSlug: z.string(),
  serviceName: z.string(),
  /** One sentence, English. */
  reason: z.string(),
  /** The model that answered, e.g. "claude-haiku-5-5". */
  model: z.string(),
  /**
   * The `Signal.id`s the pick cites, as stored. One may no longer be among `signals` when the
   * lead was scored again after the pick (see the comment on #20); the page says so.
   */
  signalIds: z.array(z.string()),
});

/** One lead, as its detail page shows it. */
export const LeadDetail = LeadRow.omit({ signals: true }).extend({
  campaignId: z.string(),
  /** Why the ideal-client filter dropped it; null unless FILTERED_OUT. */
  filterReason: z.string().nullable(),
  /** Highest points first. */
  signals: z.array(DetailSignal),
  /** Newest first; undated reviews last. */
  reviews: z.array(LeadReview),
  /** Null when the agent has not picked a service (yet, or ever: COLD, NO_STRONG_SIGNAL, …). */
  solution: LeadSolution.nullable(),
});
/** Parsed lead detail. Shares the schema's name so one import gives both. */
export type LeadDetail = z.infer<typeof LeadDetail>;
