/**
 * The ideal-client filter: decides from pass-1 data alone whether a place is worth enriching.
 *
 * Serves: FR-8, ADR-0015 (the filter runs before any review is paid for).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/db/discovery.repository.ts,
 * apps/api/src/pipeline/ideal-client-filter.spec.ts.
 */
import type { IdealClient } from '@voxflow/shared';
import type { CompassPlaceItem } from '../adapters/lead-source/apify-items.js';

// The niche's chainRule in words: "same normalized name found at 3 or more places in one campaign".
const CHAIN_MIN_PLACES = 3;

/** The fields of a Compass place the filter reads. */
export type FilterablePlace = Pick<
  CompassPlaceItem,
  | 'title'
  | 'categoryName'
  | 'categories'
  | 'totalScore'
  | 'reviewsCount'
  | 'permanentlyClosed'
  | 'temporarilyClosed'
>;

/** The `Lead.filterReason` of a temporarily closed place: the one reason a later search can undo. */
export const TEMPORARILY_CLOSED_REASON = 'temporarily closed';

/** The filter's verdict; `reason` is what `Lead.filterReason` stores and the dashboard shows. */
type FilterResult = { pass: true } | { pass: false; reason: string };

/**
 * Reduces a business name to the form names are compared in.
 *
 * Does not remove words like "clinic" or "branch": two different names stay different, so this can
 * under-count a chain but never joins two unrelated clinics.
 * @param name - The name as listed.
 * @returns Lowercase letters, marks and digits, with one space between words.
 */
export function normalizeName(name: string): string {
  return name
    .normalize('NFKC')
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * Counts how many places carry each normalized name.
 *
 * Does not remove repeats: pass one title per distinct place, or a duplicate result looks like a
 * branch.
 * @param titles - One title per distinct place in the campaign.
 * @returns Count per normalized name, as {@link idealClientFilter} expects.
 */
export function countChainNames(titles: readonly string[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const name = normalizeName(title);
    counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  return counts;
}

// The keyword and its plural, so "hospital" also matches "City Hospitals".
const keywordForms = (keyword: string): string[] => {
  const singular = normalizeName(keyword);
  if (/[^aeiou]y$/.test(singular)) return [singular, `${singular.slice(0, -1)}ies`];
  return [singular, /(?:s|x|z|ch|sh)$/.test(singular) ? `${singular}es` : `${singular}s`];
};

// Whole words only: `includes` alone would drop "Trusted Smiles" for the keyword "trust".
const containsKeyword = (text: string, keyword: string): boolean => {
  const padded = ` ${normalizeName(text)} `;
  return keywordForms(keyword).some((form) => padded.includes(` ${form} `));
};

// Only a flag that is true counts: a place with no status stays in.
const closedReason = (place: FilterablePlace, rules: IdealClient): string | null => {
  if (!rules.excludeClosed) return null;
  if (place.permanentlyClosed === true) return 'permanently closed';
  return place.temporarilyClosed === true ? TEMPORARILY_CLOSED_REASON : null;
};

/**
 * Says whether a place's listing shows it open.
 * @param place - Its two closed flags.
 * @returns True unless a flag is true, so a place with no status counts as open.
 */
export function isOpen(
  place: Pick<FilterablePlace, 'permanentlyClosed' | 'temporarilyClosed'>,
): boolean {
  return place.permanentlyClosed !== true && place.temporarilyClosed !== true;
}

/**
 * Applies a niche's ideal-client rules to one place.
 *
 * Does not look at advertised places, only at the rules FR-8 names.
 * Does not match a keyword inside a longer word, and expects keywords written in the singular: the
 * plural is worked out here, not the other way round.
 * "Private" has no field of its own: a place counts as private when none of its Maps categories
 * holds one of the niche's excluded words.
 * @param place - The place's filter fields.
 * @param rules - The niche's `idealClient` rules.
 * @param chainCounts - Places per normalized name in the campaign, from {@link countChainNames}.
 * @returns `{ pass: true }`, or `{ pass: false, reason }` naming the first rule it failed.
 */
export function idealClientFilter(
  place: FilterablePlace,
  rules: IdealClient,
  chainCounts: ReadonlyMap<string, number>,
): FilterResult {
  const closed = closedReason(place, rules);
  if (closed !== null) return { pass: false, reason: closed };

  const keywords = rules.excludeNameKeywords;
  if (rules.privateClinicOnly) {
    const categories = [place.categoryName, ...place.categories].filter((name) => name !== null);
    const found = categories.find((name) => keywords.some((word) => containsKeyword(name, word)));
    if (found !== undefined) {
      return { pass: false, reason: `not a private clinic: category "${found}"` };
    }
  }
  const keyword = keywords.find((word) => containsKeyword(place.title, word));
  if (keyword !== undefined) return { pass: false, reason: `name contains "${keyword}"` };

  if (place.totalScore === null) return { pass: false, reason: 'no rating' };
  if (place.totalScore < rules.minRating) {
    return {
      pass: false,
      reason: `rating ${String(place.totalScore)} is below the minimum ${String(rules.minRating)}`,
    };
  }
  if (place.reviewsCount < rules.minReviewCount) {
    return {
      pass: false,
      reason: `${String(place.reviewsCount)} reviews is below the minimum ${String(rules.minReviewCount)}`,
    };
  }
  const places = chainCounts.get(normalizeName(place.title)) ?? 0;
  if (rules.excludeChains && places >= CHAIN_MIN_PLACES) {
    return {
      pass: false,
      reason: `chain: ${String(places)} places with this name in the campaign`,
    };
  }
  return { pass: true };
}
