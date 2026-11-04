/**
 * Zod schemas for creating a campaign and for the campaign summary the API returns.
 *
 * Serves: FR-1 (create from niche, city, areas), FR-2 (search grid and duplicate rate), FR-3 (status).
 * Used by: apps/api/src/modules/campaigns/; later the dashboard's campaign pages (#16).
 */
import { z } from 'zod';

// Every status of FR-3's state machine, as stored in `Campaign.status`.
const CampaignStatus = z.enum([
  'DISCOVERING',
  'ENRICHING',
  'SCORING',
  'SCRIPTING',
  'AWAITING_APPROVAL',
  'CALLING',
  'COMPLETED',
  'PAUSED',
  'FAILED',
]);

const MAX_AREAS = 20;
// ADR-0010's cap: nothing may ask Apify for more per search, only for less.
const MAX_RESULTS_PER_SEARCH = 100;
const CAP_MESSAGE = `maxResultsPerSearch must be a whole number from 1 to ${String(MAX_RESULTS_PER_SEARCH)}`;
// Areas become Apify search queries; nothing real is this long.
const MAX_TEXT = 100;

// The same message whether the field is missing or blank.
const requiredText = (message: string) =>
  z
    .string({ error: message })
    .trim()
    .min(1, message)
    .max(MAX_TEXT, `at most ${String(MAX_TEXT)} characters`);

/** Body of `POST /campaigns`. Areas are trimmed; the same area twice, in any case, is refused. */
export const CreateCampaignInput = z.strictObject({
  nicheSlug: requiredText('nicheSlug is required'),
  city: requiredText('city is required'),
  areas: z
    .array(requiredText('an area cannot be empty'), { error: 'areas must be a list of area names' })
    .min(1, 'give at least one area')
    .max(MAX_AREAS, `give at most ${String(MAX_AREAS)} areas`)
    .refine(
      (areas) => new Set(areas.map((area) => area.toLowerCase())).size === areas.length,
      'each area may appear only once',
    ),
  // Lower it for a cheap test run; left out, the database default of 100 applies (FR-2).
  maxResultsPerSearch: z
    .number({ error: CAP_MESSAGE })
    .int(CAP_MESSAGE)
    .min(1, CAP_MESSAGE)
    .max(MAX_RESULTS_PER_SEARCH, CAP_MESSAGE)
    .optional(),
});
/** Parsed `POST /campaigns` body. Shares the schema's name so one import gives both. */
export type CreateCampaignInput = z.infer<typeof CreateCampaignInput>;

/** One campaign as `GET /campaigns` and `GET /campaigns/:id` return it. */
export const CampaignSummary = z.object({
  id: z.string(),
  nicheSlug: z.string(),
  city: z.string(),
  areas: z.array(z.string()),
  status: CampaignStatus,
  // FR-33: why the system paused it, e.g. a spend cap; null for an operator pause or when not paused.
  pauseReason: z.string().nullable(),
  // FR-2: one search per niche search term per area, each capped at maxResultsPerSearch.
  grid: z.object({
    terms: z.number().int().positive(),
    areas: z.number().int().positive(),
    searches: z.number().int().positive(),
  }),
  maxResultsPerSearch: z.number().int().positive(),
  // Every result discovery received, duplicates included, so duplicateCount never exceeds it.
  foundCount: z.number().int().nonnegative(),
  duplicateCount: z.number().int().nonnegative(),
  // duplicateCount / foundCount, 0–1 with 2 decimals; null until discovery has found anything.
  duplicateRate: z.number().min(0).max(1).nullable(),
  filteredCount: z.number().int().nonnegative(),
  createdAt: z.iso.datetime(),
});
/** Parsed campaign summary. Shares the schema's name so one import gives both. */
export type CampaignSummary = z.infer<typeof CampaignSummary>;
