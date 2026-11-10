/**
 * Zod schema for `Lead.websiteEvidence`: what reading a clinic's website found, kept as evidence
 * for scoring.
 *
 * Serves: FR-10, FR-14 ("no evidence, no points"), issue #11; the scoring inputs of #14.
 * Used by: apps/api/src/db/lead-website.repository.ts, apps/api/src/pipeline/enrich.step.ts,
 * apps/api/test/enrich.int.spec.ts.
 */
import { z } from 'zod';

/**
 * The website evidence of one lead. The other lists hold what an extractor matched, as found, on
 * the pages in `pagesRead`; an empty list means nothing was found, or the site was not read.
 *
 * Does not hold emails, WhatsApp or social links: those have their own Lead columns.
 */
export const WebsiteEvidence = z.strictObject({
  /** Every doctor named, "Dr. <name>" or "ڈاکٹر <name>", in page order, homepage first. */
  doctors: z.array(z.string()),
  /** The dental treatments listed, by canonical name. */
  treatments: z.array(z.string()),
  /** Booking widget URLs, and "form: <text>" for each booking form. */
  onlineBooking: z.array(z.string()),
  /** Chat script URLs, "inline script: <name>" or "WhatsApp widget: <class>". */
  chatWidgets: z.array(z.string()),
  /** The URLs of the pages read, homepage first: the evidence for "no online booking". */
  pagesRead: z.array(z.string()),
  /** Why the site is UNREADABLE, in the reader's fixed words; absent when it was read. */
  unreadableReason: z.string().optional(),
});
/** Parsed `Lead.websiteEvidence`. Shares the schema's name so one import gives both. */
export type WebsiteEvidence = z.infer<typeof WebsiteEvidence>;
