/**
 * The website part of the enrich step: read a lead's website and store what it shows. Reviews
 * (#12) and business context (#13) come later; #15 runs this from the lead graph.
 *
 * Serves: FR-9, FR-10, FR-14 (stores the evidence scoring reads), ADR-0004; issue #11.
 * Used by: apps/api/test/enrich.int.spec.ts.
 */
import type { WebsiteEvidence } from '@voxflow/shared';
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

const NO_EVIDENCE: WebsiteEvidence = {
  doctors: [],
  treatments: [],
  onlineBooking: [],
  chatWidgets: [],
  pagesRead: [],
};

const NO_WEBSITE: LeadWebsiteFacts = {
  websiteStatus: 'NONE',
  emails: [],
  whatsappLinks: [],
  socialLinks: [],
  hasOnlineBooking: null,
  hasChatWidget: null,
  decisionMakerName: null,
  websiteEvidence: NO_EVIDENCE,
};

/**
 * Turns a website read into the Lead columns it fills, evidence included.
 *
 * `decisionMakerName` is the first doctor found, homepage first, then the contact page; the
 * founder accepted that the first name is only the likeliest lead doctor (#11).
 * Does not say "no booking" for an unreadable site: the booking and chat flags stay null, unknown,
 * because no_online_booking must not count an UNREADABLE site.
 * @param read - The web reader's result.
 * @returns The columns, and the evidence: what each extractor matched, or why the site is
 * unreadable.
 */
function websiteFacts(read: WebsiteRead): LeadWebsiteFacts {
  if (read.status === 'UNREADABLE') {
    return {
      ...NO_WEBSITE,
      websiteStatus: 'UNREADABLE',
      websiteEvidence: { ...NO_EVIDENCE, unreadableReason: read.reason },
    };
  }
  const { pages } = read;
  const evidence: WebsiteEvidence = {
    doctors: doctorNames(pages),
    treatments: treatments(pages),
    onlineBooking: onlineBooking(pages),
    chatWidgets: chatWidgets(pages),
    pagesRead: pages.map((page) => page.url),
  };
  return {
    websiteStatus: read.status,
    emails: emails(pages),
    whatsappLinks: whatsappLinks(pages),
    socialLinks: socialLinks(pages),
    hasOnlineBooking: evidence.onlineBooking.length > 0,
    hasChatWidget: evidence.chatWidgets.length > 0,
    decisionMakerName: evidence.doctors[0] ?? null,
    websiteEvidence: evidence,
  };
}

/**
 * Reads a lead's website, when it has one, and stores the status, extracted fields and evidence.
 *
 * Safe to repeat: a second run reads the site again and replaces the first run's fields.
 * Logs only the lead id, the domain, the status and, for an UNREADABLE site, the reader's fixed
 * reason: never page text, emails, phones or names.
 * Does not change the lead's status: enrichment is finished when reviews and context are in too.
 * @param deps - Its dependencies.
 * @param leadId - `Lead.id` of the lead to enrich.
 * @returns The website status stored: NONE, READ_FETCH, READ_LIGHTPANDA or UNREADABLE.
 * @throws Prisma errors, e.g. when there is no such lead; ZodError when the evidence does not
 * match WebsiteEvidence, and then nothing is stored. The reader and the extractors do not throw,
 * not even for a malformed link on the page.
 */
export async function enrichWebsite(
  deps: EnrichWebsiteDeps,
  leadId: string,
): Promise<LeadWebsiteFacts['websiteStatus']> {
  const website = await deps.leads.websiteOf(leadId);
  if (website === null) {
    await deps.leads.saveWebsite(leadId, NO_WEBSITE);
    deps.logger.info({ leadId, status: 'NONE' }, 'lead has no website');
    return NO_WEBSITE.websiteStatus;
  }
  const read = await deps.webReader.read(website);
  await deps.leads.saveWebsite(leadId, websiteFacts(read));
  const domain = URL.parse(website)?.hostname ?? null;
  // The reason is one of the reader's fixed phrases, never text taken from the page.
  const reason = read.status === 'UNREADABLE' ? { reason: read.reason } : {};
  deps.logger.info({ leadId, domain, status: read.status, ...reason }, 'website read');
  return read.status;
}
