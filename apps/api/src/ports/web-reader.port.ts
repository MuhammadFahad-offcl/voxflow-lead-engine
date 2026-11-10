/**
 * The port the enrich step reads a clinic's website through: homepage plus one contact page.
 *
 * Serves: FR-9, ADR-0004 (fetch, then Lightpanda, else unreadable), ADR-0007; issue #11.
 * Used by: apps/api/src/adapters/web-reader/.
 */

/** One page that was read. */
export interface WebPage {
  /** The URL that answered, after redirects. */
  url: string;
  html: string;
  /** Visible text, one line per block: scripts, styles and markup removed, spaces collapsed. */
  text: string;
}

/** A read: the homepage, then any contact page; or UNREADABLE with a reason in fixed words. */
export type WebsiteRead =
  | { status: 'READ_FETCH' | 'READ_LIGHTPANDA'; pages: WebPage[] }
  | { status: 'UNREADABLE'; pages: []; reason: string };
