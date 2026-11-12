/**
 * The lead table's API shapes: the filters and sort of `GET /campaigns/:id/leads`,
 * and one page of leads with their evidence.
 *
 * Serves: FR-30 (lead table: filter, sort, CSV), FR-14 (evidence per signal), FR-32 (status and
 * error), US-14; issue #16.
 * Used by: apps/api/src/modules/leads/*, apps/web (#16).
 */
import { z } from 'zod';
import { ScoreBreakdown } from './score.js';

/** Rows per page of the lead table. */
export const LEAD_PAGE_SIZE = 50;

// Every status of a lead, as stored in `Lead.status`.
const LeadStatus = z.enum([
  'DISCOVERED',
  'FILTERED_OUT',
  'ENRICHED',
  'SCORED',
  'NO_STRONG_SIGNAL',
  'NEEDS_REVIEW',
  'READY_TO_CALL',
  'IN_CALLING',
  'BOOKED',
  'CLOSED',
  'FAILED',
]);
const Tier = z.enum(['HOT', 'WARM', 'COLD']);
// An empty field (`?minScore=`, as a GET form sends it) means "no bound", not 0.
const Score = z.preprocess(
  (value) => (value === '' ? undefined : value),
  z.coerce.number().int().min(0).max(100).optional(),
);
// Letters (any script), digits, spaces, `.`, `'` and `-`: every real area name, e.g. "DHA Phase 5".
// No `%` or `_`, which the database's case-insensitive match would read as wildcards.
const AREA = /^[\p{L}\p{N} .'-]+$/u;

/**
 * The lead table's query string. Values arrive as text, so numbers are coerced; anything unknown
 * is refused, so a typo in a filter does not silently show every lead.
 */
export const LeadListQuery = z
  .strictObject({
    tier: Tier.optional(),
    status: LeadStatus.optional(),
    // Matched whole and case-insensitively against `Lead.area`, e.g. "DHA".
    area: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(AREA, 'area may hold letters, digits, spaces, dots, apostrophes and hyphens')
      .optional(),
    minScore: Score,
    maxScore: Score,
    sort: z.enum(['score', 'name', 'reviews']).default('score'),
    // Left out: highest first for score and reviews, A to Z for name.
    dir: z.enum(['asc', 'desc']).optional(),
    page: z.coerce.number().int().min(1).max(10_000).default(1),
  })
  .refine(
    (query) =>
      query.minScore === undefined ||
      query.maxScore === undefined ||
      query.minScore <= query.maxScore,
    { message: 'minScore must not be above maxScore', path: ['minScore'] },
  );
/** Parsed lead-table query. Shares the schema's name so one import gives both. */
export type LeadListQuery = z.infer<typeof LeadListQuery>;

/** One scored signal of a lead, with its evidence (FR-14). A 0-point row explains a missing score. */
const LeadSignal = z.object({
  key: z.string(),
  dimension: z.enum(['PAIN', 'FIT', 'REACHABILITY', 'ABILITY_TO_PAY']),
  points: z.number().int().min(0),
  evidence: z.string(),
  sourceUrl: z.string().nullable(),
});

/** One row of the lead table. */
export const LeadRow = z.object({
  id: z.string(),
  name: z.string(),
  area: z.string().nullable(),
  /** E.164, e.g. "+923001234567"; shown to the founder only, never logged. */
  phone: z.string().nullable(),
  phoneType: z.enum(['MOBILE', 'LANDLINE', 'UNKNOWN']),
  website: z.string().nullable(),
  rating: z.number().nullable(),
  reviewCount: z.number().int().nullable(),
  score: z.number().int().nullable(),
  tier: Tier.nullable(),
  status: LeadStatus,
  failedStep: z.string().nullable(),
  error: z.string().nullable(),
  breakdown: ScoreBreakdown.nullable(),
  /** Highest points first. */
  signals: z.array(LeadSignal),
});
/** Parsed lead row. */
export type LeadRow = z.infer<typeof LeadRow>;

/** One page of the lead table. */
export const LeadPage = z.object({
  leads: z.array(LeadRow),
  /** Every lead matching the filters, on all pages. */
  total: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  pageSize: z.number().int().positive(),
});
/** Parsed lead page. */
export type LeadPage = z.infer<typeof LeadPage>;
