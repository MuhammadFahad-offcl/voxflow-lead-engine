/**
 * The website part of the enrich step: read a lead's website and store what it shows. Reviews
 * (#12) and business context (#13) come later; #15 runs this from the lead graph.
 *
 * Serves: FR-9, FR-10, ADR-0004; issue #11.
 * Used by: apps/api/test/enrich.int.spec.ts.
 */
import type { LeadWebsiteFacts, LeadWebsiteRepository } from '../db/lead-website.repository.js';
import type { Logger } from '../logging/logger.js';
import type { WebReaderPort, WebsiteRead } from '../ports/web-reader.port.js';
import { doctorNames, treatments } from './extract/clinic-text.js';
import {
  chatWidgets,
  emails,
  onlineBooking,
  socialLinks,
  whatsappLinks,
} from './extract/site-links.js';

/** What the step needs from outside. */
export interface EnrichWebsiteDeps {
  leads: LeadWebsiteRepository;
  webReader: WebReaderPort;
  logger: Logger;
}

/** What the step found that has no Lead column yet; scoring (#14) needs it as evidence. */
interface UnstoredEvidence {
  /** Every doctor named, "Dr. <name>" or "ڈاکٹر <name>"; only the first is stored. */
  doctors: string[];
  /** The treatments listed, by canonical name. */
  treatments: string[];
}

const NO_WEBSITE: LeadWebsiteFacts = {
  websiteStatus: 'NONE',
  emails: [],
  whatsappLinks: [],
  socialLinks: [],
  hasOnlineBooking: null,
  hasChatWidget: null,
  decisionMakerName: null,
};

/**
 * Turns a website read into the Lead columns it fills.
 *
 * Does not say "no booking" for an unreadable site: the booking and chat flags stay null, unknown,
 * because no_online_booking must not count an UNREADABLE site.
 * @param read - The web reader's result.
 * @returns The columns, with the first doctor named as the likely decision maker.
 */
function websiteFacts(read: WebsiteRead): LeadWebsiteFacts {
  if (read.status === 'UNREADABLE') return { ...NO_WEBSITE, websiteStatus: 'UNREADABLE' };
  const { pages } = read;
  return {
    websiteStatus: read.status,
    emails: emails(pages),
    whatsappLinks: whatsappLinks(pages),
    socialLinks: socialLinks(pages),
    hasOnlineBooking: onlineBooking(pages).length > 0,
    hasChatWidget: chatWidgets(pages).length > 0,
    decisionMakerName: doctorNames(pages)[0] ?? null,
  };
}

/**
 * Reads a lead's website, when it has one, and stores the status and extracted fields.
 *
 * Safe to repeat: a second run reads the site again and replaces the first run's fields.
 * Logs only the lead id, the domain and the status: never page text, emails, phones or names.
 * Does not change the lead's status: enrichment is finished when reviews and context are in too.
 * @param deps - Its dependencies.
 * @param leadId - `Lead.id` of the lead to enrich.
 * @returns The evidence that has no column yet, for the graph to hand to scoring.
 * @throws Prisma errors, e.g. when there is no such lead. The reader and the extractors do not
 * throw, not even for a malformed link on the page.
 */
export async function enrichWebsite(
  deps: EnrichWebsiteDeps,
  leadId: string,
): Promise<UnstoredEvidence> {
  const website = await deps.leads.websiteOf(leadId);
  if (website === null) {
    await deps.leads.saveWebsite(leadId, NO_WEBSITE);
    deps.logger.info({ leadId, status: 'NONE' }, 'lead has no website');
    return { doctors: [], treatments: [] };
  }
  const read = await deps.webReader.read(website);
  await deps.leads.saveWebsite(leadId, websiteFacts(read));
  const domain = URL.parse(website)?.hostname ?? null;
  deps.logger.info({ leadId, domain, status: read.status }, 'website read');
  return { doctors: doctorNames(read.pages), treatments: treatments(read.pages) };
}
