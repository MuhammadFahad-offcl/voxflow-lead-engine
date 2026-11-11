/**
 * What scoring reads: the facts about one lead, and the scoring rules of its niche version. Plain
 * data, so the rules are pure functions testable without a database.
 *
 * Serves: FR-14, FR-15, PRD "Lead scoring model"; issue #14.
 * Used by: apps/api/src/scoring/signals.ts, apps/api/src/scoring/score-lead.ts and their specs.
 */
import type { BusinessContext, WebsiteEvidence } from '@voxflow/shared';

/** The four score dimensions of the PRD, as `Signal.dimension` stores them. */
export type Dimension = 'PAIN' | 'FIT' | 'REACHABILITY' | 'ABILITY_TO_PAY';

/** One stored review, with the labels the review-labelling task gave it (#13). */
export interface ReviewFact {
  /** `Review.id`, cited by review signals. */
  id: string;
  /** Empty for a star-only review. */
  text: string;
  /** Empty until labelled. */
  labels: string[];
  ownerReplied: boolean;
  /** Null sorts as the oldest. */
  publishedAt: Date | null;
}

/** Everything the 13 signals read about one lead. */
export interface LeadFacts {
  /** The lead's stored reviews, in any order; scoring takes the 30 newest. */
  reviews: ReviewFact[];
  /** The listing's total Google review count. */
  reviewCount: number | null;
  /** The Maps category, e.g. "Dental clinic". */
  category: string | null;
  /** The listing's website, or null when it has none. */
  website: string | null;
  websiteStatus: 'NONE' | 'PENDING' | 'READ_FETCH' | 'READ_LIGHTPANDA' | 'UNREADABLE';
  /** Null when the site was not read or is unreadable (unknown, never false). */
  hasOnlineBooking: boolean | null;
  /** What the website reader matched (#11); null until the website is read. */
  websiteEvidence: WebsiteEvidence | null;
  /**
   * The Maps listing's booking links (Google "Book", reserve, booking sites); null when the
   * listing data has no booking field at all.
   */
  listingBookingLinks: string[] | null;
  /** E.164, e.g. "+923001234567". */
  phone: string | null;
  phoneType: 'MOBILE' | 'LANDLINE' | 'UNKNOWN';
  /** wa.me and api.whatsapp.com links found on the website. */
  whatsappLinks: string[];
  /** Social profile links found on the website. */
  socialLinks: string[];
  /** The first doctor named on the website (#11). */
  decisionMakerName: string | null;
  /** The area the lead was found in, e.g. "DHA". */
  area: string | null;
  /** The Perplexity web context (#12); null when none was stored. */
  businessContext: BusinessContext | null;
}

/** The scoring rules of one niche version, as its `NicheProfile` row stores them. */
export interface NicheRules {
  /** Points per signal key, grouped by dimension; they add up to 100. */
  signalWeights: Record<Dimension, Record<string, { points: number }>>;
  /** Hot at or above `hot`, warm at or above `warm`, cold below. */
  tiers: { hot: number; warm: number };
  /** Maps categories that count as a niche match. */
  categoryKeywords: string[];
  /** Areas that count as premium. */
  premiumAreas: string[];
}
