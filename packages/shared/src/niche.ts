/**
 * Zod schemas for a niche profile file (config/niches/<slug>.json) and the service catalog
 * (config/catalog/services.json).
 *
 * Serves: FR-4 (niche profile), FR-8 (ideal-client rules), FR-14/FR-15 (signal weights and tiers),
 * FR-16 (catalog), PRD "Lead scoring model".
 * Used by: apps/api/src/db/seed.ts.
 */
import { z } from 'zod';

// The 13 scoring signals of the PRD "Lead scoring model", by group. Exact keys, so a typo in a
// niche file fails validation instead of silently scoring 0.
const SIGNAL_KEYS = {
  PAIN: [
    'phone_unanswered_reviews',
    'booking_wait_reviews',
    'no_online_booking',
    'reviews_unreplied',
  ],
  FIT: ['category_match', 'multiple_doctors_services', 'many_reviews'],
  REACHABILITY: ['mobile_number', 'whatsapp_link', 'decision_maker_name'],
  ABILITY_TO_PAY: ['working_website', 'premium_area', 'active_marketing'],
} as const;

const Signal = z.object({
  points: z.number().int().positive(),
  // The rule in words, shown next to the evidence on the lead page.
  rule: z.string().min(1),
});

const signalGroup = <const K extends readonly [string, ...string[]]>(keys: K) =>
  z.strictObject(
    Object.fromEntries(keys.map((key) => [key, Signal])) as Record<K[number], typeof Signal>,
  );

const SignalWeights = z
  .strictObject({
    PAIN: signalGroup(SIGNAL_KEYS.PAIN),
    FIT: signalGroup(SIGNAL_KEYS.FIT),
    REACHABILITY: signalGroup(SIGNAL_KEYS.REACHABILITY),
    ABILITY_TO_PAY: signalGroup(SIGNAL_KEYS.ABILITY_TO_PAY),
  })
  .refine(
    (weights) =>
      Object.values(weights)
        .flatMap((group) => Object.values<{ points: number }>(group))
        .reduce((sum, signal) => sum + signal.points, 0) === 100,
    'signal points must add up to 100, so a score is out of 100',
  );

/** A niche's ideal-client rules (FR-8), as `NicheProfile.idealClient` stores them. */
export const IdealClient = z.object({
  // Defaults to off: a stored niche version from before this rule keeps behaving as it did.
  excludeClosed: z.boolean().default(false),
  privateClinicOnly: z.boolean(),
  minRating: z.number().min(0).max(5),
  minReviewCount: z.number().int().nonnegative(),
  excludeNameKeywords: z.array(z.string().min(1)),
  excludeChains: z.boolean(),
  chainRule: z.string().min(1),
});
/** Parsed ideal-client rules. Shares the schema's name so one import gives both. */
export type IdealClient = z.infer<typeof IdealClient>;

/** A niche profile file. `meta` (draft status, open questions) is allowed and not stored. */
export const NicheFile = z
  .object({
    meta: z.unknown().optional(),
    slug: z.string().regex(/^[a-z0-9-]+$/),
    version: z.number().int().positive(),
    name: z.string().min(1),
    searchTerms: z.array(z.string().min(1)).min(1),
    categoryKeywords: z.array(z.string().min(1)).min(1),
    idealClient: IdealClient,
    tiers: z
      .object({ hot: z.number().int().max(100), warm: z.number().int().min(0) })
      .refine((tiers) => tiers.warm < tiers.hot, 'warm must be below hot'),
    signalWeights: SignalWeights,
    reviewLabels: z.array(z.string().regex(/^[A-Z_]+$/)).min(1),
    premiumAreas: z.array(z.string().min(1)),
    defaultAreas: z.array(z.string().min(1)).min(1),
    // Read from the same folder; its text becomes NicheProfile.scriptTemplate.
    scriptTemplateFile: z.string().regex(/^[\w.-]+\.md$/),
  })
  .strict();

// Latin and Urdu (Extended Arabic-Indic) digits.
const HAS_DIGIT = /[0-9۰-۹٠-٩]/;
const noNumbers = (text: string) => !HAS_DIGIT.test(text);

/** The service catalog file. Each service's fitting signals are checked against a niche separately. */
export const CatalogFile = z.object({
  meta: z.unknown().optional(),
  services: z
    .array(
      z.strictObject({
        slug: z.string().regex(/^[a-z0-9-]+$/),
        name: z.string().min(1),
        nameUrdu: z.string().min(1),
        problem: z.string().min(1),
        fittingSignals: z.array(z.string().min(1)).min(1),
        // Spoken on the call or shown as the promise: the founder gives figures, never the AI.
        expectedResult: z.string().min(1).refine(noNumbers, 'must not contain numbers'),
        expectedResultUrdu: z.string().min(1).refine(noNumbers, 'must not contain numbers'),
      }),
    )
    .min(1)
    .refine(
      (services) => new Set(services.map((service) => service.slug)).size === services.length,
      'service slugs must be unique',
    ),
});
