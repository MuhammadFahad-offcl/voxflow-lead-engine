/**
 * Zod schema for `Lead.businessContext`: a short web summary of a business, with the sources it
 * came from so each claim can be cited as evidence.
 *
 * Serves: FR-12, FR-14 ("no evidence, no points"), issue #12; the evidence reads of #14.
 * Used by: apps/api/src/adapters/web-context/, apps/api/src/ports/web-context.port.ts.
 */
import { z } from 'zod';

/** One web page the context came from, with the excerpt the search returned for it. */
const ContextSource = z.strictObject({
  title: z.string(),
  url: z.url(),
  /** The search engine's excerpt of the page, trimmed; the text a claim can be cited against. */
  snippet: z.string(),
  /** Publication date as the search returned it (YYYY-MM-DD); null when it gave none. */
  date: z.string().nullable(),
});

/**
 * What a web search found about one business. Both fields are empty when the search found nothing:
 * that is a valid result, not a failure.
 *
 * Does not hold facts such as a decision maker or paid ads: the Search API returns excerpts, and
 * reading them for facts needs the LLM, so the prompt's `facts` block is left to #13 and #14.
 */
export const BusinessContext = z.strictObject({
  /** The top excerpts joined into a short text, in rank order. It repeats the stored snippets. */
  summary: z.string(),
  /** The ranked pages behind the summary. */
  sources: z.array(ContextSource),
});
/** Parsed `Lead.businessContext`. Shares the schema's name so one import gives both. */
export type BusinessContext = z.infer<typeof BusinessContext>;
