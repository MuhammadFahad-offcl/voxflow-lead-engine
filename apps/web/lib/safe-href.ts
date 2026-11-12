/**
 * Which URLs the dashboard may render as links: only absolute http(s) URLs. Evidence sources come
 * from scraped websites and web search results, so a `javascript:` or `data:` URL must never become
 * a clickable link.
 *
 * Serves: NFR-5 (no script from outside data runs in the dashboard), FR-14 (evidence sources);
 * T-1 audit.
 * Used by: apps/web/app/campaigns/[id]/lead-evidence.tsx, apps/web/lib/safe-href.spec.ts.
 */

/**
 * Checks a URL before it becomes an `href`.
 * @param value - A stored URL, e.g. a signal's `sourceUrl`.
 * @returns The URL as the browser would read it, when it is http or https; otherwise null, and
 * the caller shows no link.
 */
export function safeHref(value: string): string | null {
  // URL.parse returns null for anything that is not an absolute URL.
  const url = URL.parse(value.trim());
  return url !== null && (url.protocol === 'http:' || url.protocol === 'https:') ? url.href : null;
}
