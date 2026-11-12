/**
 * The lead table's URL state: which filters, sort and page the founder chose. Kept in the page's
 * query string, so a filtered view is a link, the back button works, and the server renders it.
 *
 * Serves: FR-30 (lead table: filter, sort, paging, CSV of the filtered rows); issue #16.
 * Used by: apps/web/app/campaigns/[id]/*, apps/web/lib/lead-query.spec.ts.
 */

/** The query keys the lead table understands; anything else in the URL is ignored. */
const KEYS = ['tier', 'status', 'area', 'minScore', 'maxScore', 'sort', 'dir', 'page'] as const;
type Key = (typeof KEYS)[number];

/** The table's state: only keys with a non-empty value. */
export type LeadQuery = Partial<Record<Key, string>>;

/**
 * Reads the table's state from a page's search params.
 *
 * Does not validate values: the API does, and answers 400 for a bad one.
 * @param params - Next.js search params; a repeated key keeps its first value.
 * @returns Only the known keys with a non-empty value, so an empty filter field means "any".
 */
export function readLeadQuery(params: Record<string, string | string[] | undefined>): LeadQuery {
  const query: LeadQuery = {};
  for (const key of KEYS) {
    const raw = params[key];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    if (value !== '') query[key] = value;
  }
  return query;
}

/**
 * Writes the state as a query string.
 * @param query - The state.
 * @param change - Keys to set; undefined removes a key.
 * @returns "?tier=HOT&page=2", or "" when nothing is set.
 */
export function toSearch(
  query: LeadQuery,
  change: Partial<Record<Key, string | undefined>> = {},
): string {
  const params = new URLSearchParams();
  const merged: Partial<Record<Key, string | undefined>> = { ...query, ...change };
  for (const key of KEYS) {
    const value = merged[key];
    if (value !== undefined && value !== '') params.set(key, value);
  }
  const text = params.toString();
  return text === '' ? '' : `?${text}`;
}

/**
 * The state after clicking a column heading: that column, its natural direction first, and the
 * other direction on a second click; back to page 1.
 * @param query - The current state.
 * @param sort - The column clicked: score, name or reviews.
 * @returns The query string to link to.
 */
export function sortLink(query: LeadQuery, sort: 'score' | 'name' | 'reviews'): string {
  const natural = sort === 'name' ? 'asc' : 'desc';
  if ((query.sort ?? 'score') !== sort)
    return toSearch(query, { sort, dir: natural, page: undefined });
  const current = query.dir ?? natural;
  return toSearch(query, { sort, dir: current === 'asc' ? 'desc' : 'asc', page: undefined });
}
