/**
 * What the Perplexity Search API is asked and answers: the query text, the response shape, the
 * price of a request, and the rule that turns results into a context. The real adapter and the
 * fake both use it, so fixtures prove the real mapping.
 *
 * Serves: FR-12, ADR-0007; issue #12. Shape: https://docs.perplexity.ai/api-reference/search-post
 * Used by: apps/api/src/adapters/web-context/fake.adapter.ts and perplexity.adapter.ts.
 */
import type { BusinessContext } from '@voxflow/shared';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import type { BusinessQuery } from '../../ports/web-context.port.js';

/**
 * What one Search API request costs, in US dollars: a flat $5.00 per 1,000 requests for
 * `search_type: "web"`, billed whatever the number of results, and not billed when the request is
 * invalid, rate limited or fails upstream. Source: https://docs.perplexity.ai/guides/pricing
 * (read 2026-11-10; the "fast" type is $1.00 per 1,000 and is not used).
 */
export const SEARCH_REQUEST_USD = new Prisma.Decimal('0.005');

/**
 * Words the search for one business: name, area and city, plus the site's host when it has one so
 * a chain's other branches rank lower.
 * @param query - The business to look up.
 * @returns The `query` string of the request.
 */
export function buildSearchQuery(query: BusinessQuery): string {
  const host = query.website === null ? undefined : URL.parse(query.website)?.hostname;
  const parts = [query.name, query.area, query.city, host?.replace(/^www\./, '')];
  return parts.filter((part) => part !== undefined && part !== '').join(' ');
}

/**
 * A 200 response of `POST /search` with one string query. Not strict: Perplexity may add fields.
 * Only the fields this code reads are required; `date` may be missing or null.
 */
export const SearchResponse = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      snippet: z.string(),
      date: z.string().nullish(),
    }),
  ),
});

// The top results are the most about this business; more only add noise and size to the column.
const MAX_SOURCES = 5;
const MAX_TITLE_CHARS = 150;
const MAX_SNIPPET_CHARS = 300;
const MAX_SUMMARY_CHARS = 1000;

const trim = (text: string, max: number): string => {
  // Cut by code points, so an emoji's surrogate pair is never split in two.
  const chars = Array.from(text.replaceAll(/\s+/g, ' ').trim());
  return chars.length <= max
    ? chars.join('')
    : `${chars
        .slice(0, max - 1)
        .join('')
        .trimEnd()}…`;
};

/**
 * Builds the stored context from a search response.
 *
 * Plain text work, no model: the summary is the sources' excerpts in rank order, so every word of
 * it can be traced to a listed source.
 * Does not judge relevance: a result about another business with a similar name is kept.
 * @param response - A validated search response.
 * @returns The summary and the top sources; both empty for no results.
 */
export function toBusinessContext(response: z.infer<typeof SearchResponse>): BusinessContext {
  const sources = response.results.slice(0, MAX_SOURCES).map((result) => ({
    title: trim(result.title, MAX_TITLE_CHARS),
    url: result.url,
    snippet: trim(result.snippet, MAX_SNIPPET_CHARS),
    date: result.date ?? null,
  }));
  const summary = trim(sources.map((source) => source.snippet).join(' '), MAX_SUMMARY_CHARS);
  return { summary, sources };
}
