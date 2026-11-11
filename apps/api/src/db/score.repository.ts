/**
 * Database access for the score step: a lead's facts and its niche version's scoring rules, read
 * and checked, and the score stored with its signals in one transaction.
 *
 * Serves: FR-14 (every point linked to a stored signal with evidence), FR-15 (tier); issue #14.
 * Used by: apps/api/src/pipeline/score.step.ts and the score integration tests.
 */
import { Injectable } from '@hazeljs/core';
import {
  BusinessContext,
  NicheTiers,
  ScoreBreakdown,
  SignalWeights,
  WebsiteEvidence,
} from '@voxflow/shared';
import { z } from 'zod';
import type { LeadStatus } from '../generated/prisma/client.js';
import type { LeadFacts, NicheRules } from '../scoring/lead-facts.js';
import type { ScoreResult } from '../scoring/score-lead.js';
import { PrismaProvider } from './prisma.provider.js';

// The booking fields of the stored Compass item (ADR-0015). Loose: rawPlace holds much more.
const ListingBooking = z.looseObject({
  bookingLinks: z.array(z.object({ url: z.string() })),
  reserveTableUrl: z.string().nullable().optional(),
});

/**
 * Reads the listing's booking links from the stored place item.
 * @param rawPlace - `Lead.rawPlace`.
 * @returns The links (Google "Book", reserve and booking-site links), or null when the item has no
 * booking field, so scoring notes that the listing was not checked.
 * @throws ZodError when the booking field is there but malformed: a data bug must not read as
 * "not checked", which still earns points.
 */
const listingBookingLinks = (rawPlace: unknown): string[] | null => {
  if (typeof rawPlace !== 'object' || rawPlace === null || !('bookingLinks' in rawPlace)) {
    return null;
  }
  const { bookingLinks, reserveTableUrl } = ListingBooking.parse(rawPlace);
  const links = bookingLinks.map((link) => link.url);
  return reserveTableUrl ? [...links, reserveTableUrl] : links;
};

/**
 * Statuses a lead can be scored in. A lead past scoring (solution, script, calls) is never sent
 * back to SCORED, so a retried graph cannot call it again; a FAILED lead may be scored again.
 */
const SCORABLE: LeadStatus[] = ['DISCOVERED', 'ENRICHED', 'SCORED', 'FAILED'];

/** What the step reads about a lead. */
export interface LeadForScoring {
  status: LeadStatus;
  facts: LeadFacts;
  niche: NicheRules;
}

/** Reads what scoring needs and stores scores. */
@Injectable()
export class ScoreRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Reads a lead's facts and the scoring rules of its campaign's niche version.
   *
   * Does not pick the 30 newest reviews: scoring does, in the same order the labelling step uses.
   * @param leadId - `Lead.id`.
   * @returns The lead's status, its facts and its niche's rules.
   * @throws Prisma's not-found error when there is no such lead; ZodError when a JSON column does
   * not match its schema (a bug, not a lead problem).
   */
  async forScoring(leadId: string): Promise<LeadForScoring> {
    const lead = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      include: {
        reviews: {
          select: { id: true, text: true, labels: true, ownerReplied: true, publishedAt: true },
        },
        campaign: {
          select: {
            nicheProfile: {
              select: {
                signalWeights: true,
                tiers: true,
                categoryKeywords: true,
                premiumAreas: true,
              },
            },
          },
        },
      },
    });
    const { nicheProfile } = lead.campaign;
    return {
      status: lead.status,
      facts: {
        reviews: lead.reviews,
        reviewCount: lead.reviewCount,
        category: lead.category,
        website: lead.website,
        websiteStatus: lead.websiteStatus,
        hasOnlineBooking: lead.hasOnlineBooking,
        websiteEvidence:
          lead.websiteEvidence === null ? null : WebsiteEvidence.parse(lead.websiteEvidence),
        listingBookingLinks: listingBookingLinks(lead.rawPlace),
        phone: lead.phone,
        phoneType: lead.phoneType,
        whatsappLinks: lead.whatsappLinks,
        socialLinks: lead.socialLinks,
        decisionMakerName: lead.decisionMakerName,
        area: lead.area,
        businessContext:
          lead.businessContext === null ? null : BusinessContext.parse(lead.businessContext),
      },
      niche: {
        signalWeights: SignalWeights.parse(nicheProfile.signalWeights),
        tiers: NicheTiers.parse(nicheProfile.tiers),
        categoryKeywords: nicheProfile.categoryKeywords,
        premiumAreas: nicheProfile.premiumAreas,
      },
    };
  }

  /**
   * Stores a score: sets the score, breakdown, tier and SCORED, and replaces the lead's signals, in
   * one transaction, so the score always matches the signals stored with it.
   *
   * Does not touch a lead whose status is not scorable any more (it moved past scoring after it
   * was read): the status check is part of the write, so the two cannot race.
   * @param leadId - `Lead.id`.
   * @param result - What `scoreLead` returned.
   * @returns True when stored; false when the lead was no longer scorable, and nothing changed.
   * @throws ZodError when the breakdown does not match its schema, and nothing is written; Prisma
   * errors, e.g. when a signal cites a review that no longer exists.
   */
  async saveScore(leadId: string, result: ScoreResult): Promise<boolean> {
    const scoreBreakdown = ScoreBreakdown.parse(result.breakdown);
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.lead.updateMany({
        where: { id: leadId, status: { in: SCORABLE } },
        data: { score: result.total, scoreBreakdown, tier: result.tier, status: 'SCORED' },
      });
      if (count === 0) return false;
      await tx.signal.deleteMany({ where: { leadId } });
      await tx.signal.createMany({ data: result.signals.map((signal) => ({ ...signal, leadId })) });
      return true;
    });
  }
}
