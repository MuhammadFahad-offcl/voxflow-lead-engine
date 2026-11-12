/**
 * The 13 scoring signals of the PRD "Lead scoring model", one pure function each. A signal finds
 * evidence and returns it, or returns null: no evidence, no points. A third outcome, a `noPoints`
 * note, is evidence of why it earns nothing (too few reviews), stored with 0 points. Points come from the niche
 * profile's weights in `scoreLead`, never from here.
 *
 * Fixed numbers here (2 of the last 30, more than half, 2+ doctors, 3+ treatments, 100+ reviews,
 * +923…) are the niche file's rule texts and the founder's #14 decisions. The minimum of stored
 * reviews for reviews_unreplied comes from the niche file itself (`minReviews`).
 *
 * Serves: FR-14 (score with evidence), PRD "Lead scoring model"; issue #14.
 * Used by: apps/api/src/scoring/score-lead.ts, apps/api/src/scoring/signals.spec.ts.
 */
import type { LeadFacts, NicheRules, ReviewFact } from './lead-facts.js';

/** What a signal found: the proof shown on the lead page, and where it came from. */
export interface SignalFinding {
  /** Never empty. */
  evidence: string;
  /** The page or link the evidence came from; for website facts, the first page read. */
  sourceUrl?: string;
  /** `Review.id` of the quoted review, for review signals. */
  reviewId?: string;
  /**
   * True when the evidence explains why the signal earns nothing (too few reviews to judge): it is
   * stored with 0 points so the lead page shows the reason.
   */
  noPoints?: true;
}

type SignalRule = (facts: LeadFacts, niche: NicheRules) => SignalFinding | null;

// The PRD counts reviews over "the last 30", the same 30 the labelling step labels (#13).
const NEWEST = 30;
const QUOTE_MAX = 200;
const READ = new Set<LeadFacts['websiteStatus']>(['READ_FETCH', 'READ_LIGHTPANDA']);
// Words that say a business pays for advertising; plain code, by the founder's #13 decision.
const PAID_ADS =
  /\b(?:sponsored|advertis(?:e|ed|ement|ements|ing)|paid ads?|google ads|facebook ads|instagram ads|meta ads)\b/i;

/**
 * Picks the reviews scoring counts.
 *
 * Does not filter by age: the PRD counts the 30 newest, however old (founder decision on #14).
 * @param reviews - A lead's stored reviews, in any order.
 * @returns The 30 newest by `publishedAt`, newest first; undated reviews last, then by id.
 */
export function newestReviews(reviews: readonly ReviewFact[]): ReviewFact[] {
  return [...reviews]
    .sort((a, b) => {
      const byDate =
        (b.publishedAt?.getTime() ?? -Infinity) - (a.publishedAt?.getTime() ?? -Infinity);
      // Two undated reviews give NaN (-Infinity minus -Infinity), so fall through to the id.
      if (!Number.isNaN(byDate) && byDate !== 0) return byDate;
      // A plain code-point comparison, like the database's order for cuids, not a locale's.
      if (a.id === b.id) return 0;
      return a.id < b.id ? -1 : 1;
    })
    .slice(0, NEWEST);
}

// One line of review text, cut to 200 characters for the evidence.
const quote = (text: string): string => text.trim().replaceAll(/\s+/g, ' ').slice(0, QUOTE_MAX);

/**
 * Builds a review signal: at least 2 of the last 30 reviews carry the label.
 * @param label - The review label the signal counts.
 * @param says - What those reviews say, for the evidence sentence.
 * @returns The rule.
 */
const reviewsLabelled =
  (label: string, says: string): SignalRule =>
  (facts) => {
    const newest = newestReviews(facts.reviews);
    const matching = newest.filter((review) => review.labels.includes(label));
    // Labelled reviews always have text: star-only ones get OTHER without a call (#13).
    const quoted = matching.filter((review) => review.text.trim() !== '').slice(0, 2);
    const [first, second] = quoted;
    if (matching.length < 2 || first === undefined || second === undefined) return null;
    // The two newest matching reviews: the PRD stores "the review texts" behind the threshold.
    return {
      evidence: `${String(matching.length)} of the last ${String(newest.length)} reviews ${says}: "${quote(first.text)}" / "${quote(second.text)}"`,
      reviewId: first.id,
    };
  };

// The website half of no_online_booking, or null when the website does not prove "no booking".
const websiteHasNoBooking = (facts: LeadFacts): { text: string; sourceUrl?: string } | null => {
  if (facts.website === null || facts.websiteStatus === 'NONE')
    return { text: 'No website listed' };
  // UNREADABLE is not proof of "no booking" (founder decision on #14), nor is a site not read yet.
  if (!READ.has(facts.websiteStatus) || facts.hasOnlineBooking !== false) return null;
  return {
    text: `Website read (${facts.websiteStatus}), no booking widget found`,
    sourceUrl: facts.websiteEvidence?.pagesRead[0] ?? facts.website,
  };
};

const noOnlineBooking: SignalRule = (facts) => {
  const website = websiteHasNoBooking(facts);
  if (website === null) return null;
  let listing: string;
  if (facts.listingBookingLinks === null) {
    listing = 'Maps listing not checked: actor gives no booking field';
  } else if (facts.listingBookingLinks.length > 0) {
    return null;
  } else {
    listing = 'Maps listing has no booking link';
  }
  const evidence = `${website.text}; ${listing}`;
  return website.sourceUrl === undefined
    ? { evidence }
    : { evidence, sourceUrl: website.sourceUrl };
};

const reviewsUnreplied: SignalRule = (facts, niche) => {
  const stored = facts.reviews.length;
  // From the niche file (founder decision after #14); a niche version without it has no minimum.
  const minimum = niche.signalWeights.PAIN['reviews_unreplied']?.minReviews ?? 0;
  if (stored < minimum) {
    const noun = stored === 1 ? 'review' : 'reviews';
    const count = stored === 0 ? 'No reviews' : `Only ${String(stored)} ${noun}`;
    return {
      evidence: `${count} stored, fewer than the ${String(minimum)} needed`,
      noPoints: true,
    };
  }
  const newest = newestReviews(facts.reviews);
  const unreplied = newest.filter((review) => !review.ownerReplied).length;
  // "More than half": 16 of 30 counts, 15 of 30 does not. Fewer than 30 stored count as they are.
  if (newest.length === 0 || unreplied * 2 <= newest.length) return null;
  return {
    evidence: `${String(unreplied)} of the last ${String(newest.length)} reviews have no owner reply`,
  };
};

const categoryMatch: SignalRule = (facts, niche) => {
  const category = facts.category?.trim() ?? '';
  const lower = category.toLowerCase();
  if (category === '' || !niche.categoryKeywords.some((key) => lower.includes(key.toLowerCase()))) {
    return null;
  }
  return { evidence: `Maps category: ${category}` };
};

const multipleDoctorsServices: SignalRule = (facts) => {
  const evidence = facts.websiteEvidence;
  if (evidence === null) return null;
  const doctors = [...new Set(evidence.doctors)];
  const treatments = [...new Set(evidence.treatments)];
  const page = evidence.pagesRead[0];
  const found = (text: string) =>
    page === undefined ? { evidence: text } : { evidence: text, sourceUrl: page };
  if (doctors.length >= 2) return found(`Doctors named on the website: ${doctors.join(', ')}`);
  if (treatments.length >= 3)
    return found(`Treatments listed on the website: ${treatments.join(', ')}`);
  return null;
};

const manyReviews: SignalRule = (facts) =>
  facts.reviewCount !== null && facts.reviewCount >= 100
    ? { evidence: `Google reviews: ${String(facts.reviewCount)}` }
    : null;

const mobileNumber: SignalRule = (facts) =>
  facts.phoneType === 'MOBILE' && facts.phone?.startsWith('+923') === true
    ? // The phone's last 4 digits only; the number itself is in `Lead.phone`. (whatsapp_link's
      // evidence is the link itself, as the PRD asks, so it keeps the number the link holds.)
      { evidence: `Listing phone is a Pakistani mobile number ending ${facts.phone.slice(-4)}` }
    : null;

const whatsappLink: SignalRule = (facts) => {
  const [link] = facts.whatsappLinks;
  return link === undefined
    ? null
    : { evidence: `WhatsApp link on the website: ${link}`, sourceUrl: link };
};

const decisionMakerName: SignalRule = (facts) => {
  const name = facts.decisionMakerName?.trim() ?? '';
  if (name === '') return null;
  const page = facts.websiteEvidence?.pagesRead[0] ?? facts.website;
  const evidence = `Doctor named on the website: ${name}`;
  return page === null ? { evidence } : { evidence, sourceUrl: page };
};

const workingWebsite: SignalRule = (facts) =>
  facts.website !== null && READ.has(facts.websiteStatus)
    ? {
        evidence: `Website read (${facts.websiteStatus}): ${facts.website}`,
        sourceUrl: facts.website,
      }
    : null;

const premiumArea: SignalRule = (facts, niche) => {
  const area = facts.area?.trim() ?? '';
  const lower = area.toLowerCase();
  // "DHA Phase 5" is in DHA; "DHAKA Road" is not.
  const premium = niche.premiumAreas.some((name) => {
    const key = name.toLowerCase();
    return lower === key || lower.startsWith(`${key} `);
  });
  return area !== '' && premium
    ? { evidence: `Area: ${area}, premium in the niche profile` }
    : null;
};

const activeMarketing: SignalRule = (facts) => {
  const [social] = facts.socialLinks;
  if (social !== undefined) {
    return { evidence: `Social profile linked on the website: ${social}`, sourceUrl: social };
  }
  const ad = facts.businessContext?.sources.find((source) => PAID_ADS.test(source.snippet));
  return ad === undefined
    ? null
    : { evidence: `Web context mentions paid ads: "${quote(ad.snippet)}"`, sourceUrl: ad.url };
};

/** The rule for each of the 13 signal keys of the niche profile's `signalWeights`. */
export const SIGNAL_RULES = {
  phone_unanswered_reviews: reviewsLabelled(
    'PHONE_UNANSWERED',
    'say the phone goes unanswered or the clinic is hard to reach',
  ),
  booking_wait_reviews: reviewsLabelled(
    'BOOKING_OR_WAIT',
    'mention difficulty booking or long waits',
  ),
  no_online_booking: noOnlineBooking,
  reviews_unreplied: reviewsUnreplied,
  category_match: categoryMatch,
  multiple_doctors_services: multipleDoctorsServices,
  many_reviews: manyReviews,
  mobile_number: mobileNumber,
  whatsapp_link: whatsappLink,
  decision_maker_name: decisionMakerName,
  working_website: workingWebsite,
  premium_area: premiumArea,
  active_marketing: activeMarketing,
} satisfies Record<string, SignalRule>;
