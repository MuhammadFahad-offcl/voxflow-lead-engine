/**
 * Unit tests of the 13 scoring signals, row by row against the PRD "Lead scoring model" and the
 * founder's #14 decisions: each signal has a "gets points" case and a "no evidence, no points" case.
 *
 * Serves: FR-14, NFR-9 (≥ 80% coverage of scoring/); issue #14.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LeadFacts, NicheRules, ReviewFact } from './lead-facts.js';
import { newestReviews, SIGNAL_RULES, type SignalFinding } from './signals.js';

// One row: the signal, facts that give it points, facts that do not, and what it finds.
type SignalCase = [
  keyof typeof SIGNAL_RULES,
  Partial<LeadFacts>,
  Partial<LeadFacts>,
  SignalFinding,
];

const NICHE: NicheRules = {
  signalWeights: { PAIN: {}, FIT: {}, REACHABILITY: {}, ABILITY_TO_PAY: {} },
  tiers: { hot: 70, warm: 45 },
  categoryKeywords: ['dental clinic', 'dentist', 'dental'],
  premiumAreas: ['DHA', 'Gulberg'],
};

// A lead with nothing scoring could use: every signal must give no points.
const nothing: LeadFacts = {
  reviews: [],
  reviewCount: null,
  category: null,
  website: null,
  websiteStatus: 'PENDING',
  hasOnlineBooking: null,
  websiteEvidence: null,
  // A listing booking link, so no_online_booking has no evidence either.
  listingBookingLinks: ['https://oladoc.example/fictional'],
  phone: null,
  phoneType: 'UNKNOWN',
  whatsappLinks: [],
  socialLinks: [],
  decisionMakerName: null,
  area: null,
  businessContext: null,
};
const facts = (overrides: Partial<LeadFacts>): LeadFacts => ({ ...nothing, ...overrides });

// Review `n` is n days older than 1 Nov 2026 (n = 1 is the newest).
const review = (n: number, overrides: Partial<ReviewFact> = {}): ReviewFact => ({
  id: `r-${String(n).padStart(2, '0')}`,
  text: `Fictional review number ${String(n)}.`,
  labels: ['OTHER'],
  ownerReplied: true,
  publishedAt: new Date(Date.UTC(2026, 10, 1 - n)),
  ...overrides,
});
const reviews = (count: number, overrides: (n: number) => Partial<ReviewFact> = () => ({})) =>
  Array.from({ length: count }, (_, index) => review(index + 1, overrides(index + 1)));

const read = {
  website: 'https://p01.example.com/',
  websiteStatus: 'READ_FETCH' as const,
  hasOnlineBooking: false,
  listingBookingLinks: [],
  websiteEvidence: {
    doctors: [],
    treatments: [],
    onlineBooking: [],
    chatWidgets: [],
    pagesRead: ['https://p01.example.com/', 'https://p01.example.com/contact'],
  },
};

// Proves "last 30" is the 30 newest by date, undated reviews last, the same order labelling uses.
describe('newestReviews', () => {
  it('keeps the 30 newest, newest first', () => {
    const newest = newestReviews([...reviews(32)].reverse());

    expect(newest).toHaveLength(30);
    expect(newest[0]?.id).toBe('r-01');
    expect(newest.at(-1)?.id).toBe('r-30');
  });

  it('puts undated reviews last, ordered by id', () => {
    const undated = [
      review(2, { id: 'r-b', publishedAt: null }),
      review(3, { id: 'r-a', publishedAt: null }),
    ];

    expect(newestReviews([...undated, review(1)]).map((r) => r.id)).toEqual(['r-01', 'r-a', 'r-b']);
  });
});

// Proves the founder's rule: 2 of the last 30 reviews with the label give points, 1 gives none.
describe.each([
  ['phone_unanswered_reviews', 'PHONE_UNANSWERED'],
  ['booking_wait_reviews', 'BOOKING_OR_WAIT'],
] as const)('%s', (key, label) => {
  const rule = SIGNAL_RULES[key];
  const withLabel = (positions: number[]) =>
    reviews(31, (n) => (positions.includes(n) ? { labels: [label] } : {}));

  it('gives no points for 1 matching review', () => {
    expect(rule(facts({ reviews: withLabel([3]) }), NICHE)).toBeNull();
  });

  it('gives points for 2 matching reviews, quoting both, with the id of the newest', () => {
    const finding = rule(facts({ reviews: withLabel([3, 7]) }), NICHE);

    expect(finding).toEqual({
      evidence: expect.stringMatching(
        /^2 of the last 30 reviews .*: "Fictional review number 3\." \/ "Fictional review number 7\."$/,
      ),
      reviewId: 'r-03',
    });
  });

  it('does not count a match in review 31, the 31st newest', () => {
    expect(rule(facts({ reviews: withLabel([3, 31]) }), NICHE)).toBeNull();
  });

  it('quotes at most 200 characters', () => {
    const long = reviews(2, () => ({ labels: [label], text: 'x'.repeat(500) }));

    const evidence = rule(facts({ reviews: long }), NICHE)?.evidence ?? '';

    expect(evidence).toMatch(/: "x{200}" \/ "x{200}"$/);
  });
});

// Proves "more than half of the last 30 have no owner reply": 15 of 30 is not enough, 16 is.
describe('reviews_unreplied', () => {
  const rule = SIGNAL_RULES.reviews_unreplied;
  const unreplied = (count: number, total = 30) =>
    reviews(total, (n) => ({ ownerReplied: n > count }));

  it('gives no points for exactly 15 of 30 unreplied', () => {
    expect(rule(facts({ reviews: unreplied(15) }), NICHE)).toBeNull();
  });

  it('gives points for 16 of 30 unreplied, with the count as evidence', () => {
    expect(rule(facts({ reviews: unreplied(16) }), NICHE)).toEqual({
      evidence: '16 of the last 30 reviews have no owner reply',
    });
  });

  it('counts only the 30 newest', () => {
    // 15 of the 30 newest are unreplied, and all 10 older ones: 25 of 40 overall.
    const many = reviews(40, (n) => ({ ownerReplied: !(n <= 15 || n > 30) }));

    expect(rule(facts({ reviews: many }), NICHE)).toBeNull();
  });

  it('gives no points without reviews', () => {
    expect(rule(nothing, NICHE)).toBeNull();
  });

  // Default where the PRD is open: fewer than 30 stored reviews count as they are.
  it('counts over the stored reviews when there are fewer than 30: 5 of 10 is not enough', () => {
    expect(rule(facts({ reviews: unreplied(5, 10) }), NICHE)).toBeNull();
  });

  it('gives points for 6 of 10 unreplied when only 10 are stored', () => {
    expect(rule(facts({ reviews: unreplied(6, 10) }), NICHE)).toEqual({
      evidence: '6 of the last 10 reviews have no owner reply',
    });
  });
});

// Proves the founder's no_online_booking rule: both the website and the Maps listing must lack booking.
describe('no_online_booking', () => {
  const rule = SIGNAL_RULES.no_online_booking;

  it('gives points with no website and no listing booking link', () => {
    expect(rule(facts({ websiteStatus: 'NONE', listingBookingLinks: [] }), NICHE)).toEqual({
      evidence: 'No website listed; Maps listing has no booking link',
    });
  });

  it('gives no points with no website when the listing has a booking link', () => {
    const listing = {
      websiteStatus: 'NONE' as const,
      listingBookingLinks: ['https://oladoc.example/x'],
    };

    expect(rule(facts(listing), NICHE)).toBeNull();
  });

  it('gives points when the website was read with no booking widget and the listing has none', () => {
    expect(rule(facts(read), NICHE)).toEqual({
      evidence:
        'Website read (READ_FETCH), no booking widget found; Maps listing has no booking link',
      sourceUrl: 'https://p01.example.com/',
    });
  });

  it('gives no points when the website has a booking widget', () => {
    expect(rule(facts({ ...read, hasOnlineBooking: true }), NICHE)).toBeNull();
  });

  it('gives no points for an unreadable website, even with no listing link', () => {
    const unreadable = {
      website: 'https://p01.example.com/',
      websiteStatus: 'UNREADABLE' as const,
    };

    expect(rule(facts(unreadable), NICHE)).toBeNull();
  });

  it('lets the website alone decide when the listing has no booking field, and says so', () => {
    expect(rule(facts({ ...read, listingBookingLinks: null }), NICHE)?.evidence).toBe(
      'Website read (READ_FETCH), no booking widget found; Maps listing not checked: actor gives no booking field',
    );
  });
});

// Proves each remaining signal: evidence gives the points, no evidence gives none.
describe('fit, reachability and ability-to-pay signals', () => {
  it.each<SignalCase>([
    [
      'category_match',
      { category: 'Dental Clinic' },
      { category: 'Pharmacy' },
      { evidence: 'Maps category: Dental Clinic' },
    ],
    [
      'multiple_doctors_services',
      {
        websiteEvidence: {
          ...read.websiteEvidence,
          doctors: ['Dr. Fictional A', 'Dr. Fictional B'],
        },
      },
      {
        websiteEvidence: {
          ...read.websiteEvidence,
          doctors: ['Dr. Fictional A', 'Dr. Fictional A'],
        },
      },
      {
        evidence: 'Doctors named on the website: Dr. Fictional A, Dr. Fictional B',
        sourceUrl: 'https://p01.example.com/',
      },
    ],
    [
      'multiple_doctors_services',
      {
        websiteEvidence: {
          ...read.websiteEvidence,
          treatments: ['implants', 'braces', 'whitening'],
        },
      },
      { websiteEvidence: { ...read.websiteEvidence, treatments: ['implants', 'braces'] } },
      {
        evidence: 'Treatments listed on the website: implants, braces, whitening',
        sourceUrl: 'https://p01.example.com/',
      },
    ],
    [
      'many_reviews',
      { reviewCount: 100 },
      { reviewCount: 99 },
      { evidence: 'Google reviews: 100' },
    ],
    [
      'mobile_number',
      { phone: '+923000000001', phoneType: 'MOBILE' as const },
      { phone: '+924200000001', phoneType: 'LANDLINE' as const },
      { evidence: 'Listing phone is a Pakistani mobile number ending 0001' },
    ],
    [
      'whatsapp_link',
      { whatsappLinks: ['https://wa.me/923000000001'] },
      { whatsappLinks: [] },
      {
        evidence: 'WhatsApp link on the website: https://wa.me/923000000001',
        sourceUrl: 'https://wa.me/923000000001',
      },
    ],
    [
      'decision_maker_name',
      { ...read, decisionMakerName: 'Dr. Fictional A' },
      { ...read, decisionMakerName: '  ' },
      {
        evidence: 'Doctor named on the website: Dr. Fictional A',
        sourceUrl: 'https://p01.example.com/',
      },
    ],
    [
      'working_website',
      read,
      { website: 'https://p01.example.com/', websiteStatus: 'UNREADABLE' as const },
      {
        evidence: 'Website read (READ_FETCH): https://p01.example.com/',
        sourceUrl: 'https://p01.example.com/',
      },
    ],
    [
      'premium_area',
      { area: 'DHA Phase 5' },
      { area: 'DHAKA Road' },
      { evidence: 'Area: DHA Phase 5, premium in the niche profile' },
    ],
    [
      'active_marketing',
      { socialLinks: ['https://facebook.com/fictional-clinic'] },
      { socialLinks: [] },
      {
        evidence: 'Social profile linked on the website: https://facebook.com/fictional-clinic',
        sourceUrl: 'https://facebook.com/fictional-clinic',
      },
    ],
  ])('%s: gives points with evidence, none without', (key, withEvidence, without, finding) => {
    const rule = SIGNAL_RULES[key];

    expect(rule(facts(withEvidence), NICHE)).toEqual(finding);
    expect(rule(facts(without), NICHE)).toBeNull();
    expect(rule(nothing, NICHE)).toBeNull();
  });

  it('active_marketing: finds paid ads in the web context, quoting the snippet', () => {
    const context = {
      summary: '',
      sources: [
        { title: 'Directory', url: 'https://d.example.com/a', snippet: 'Open 9 to 5.', date: null },
        {
          title: 'Offer',
          url: 'https://d.example.com/b',
          snippet: 'Sponsored: whitening offer this month.',
          date: null,
        },
      ],
    };

    expect(SIGNAL_RULES.active_marketing(facts({ businessContext: context }), NICHE)).toEqual({
      evidence: 'Web context mentions paid ads: "Sponsored: whitening offer this month."',
      sourceUrl: 'https://d.example.com/b',
    });
  });

  it('active_marketing: ignores a context with no ad words', () => {
    const context = {
      summary: '',
      sources: [
        { title: 'A', url: 'https://d.example.com/a', snippet: 'A road nearby.', date: null },
      ],
    };

    expect(SIGNAL_RULES.active_marketing(facts({ businessContext: context }), NICHE)).toBeNull();
  });

  it('mobile_number: needs a +923 number even when the type says mobile', () => {
    const odd = { phone: '+14155550100', phoneType: 'MOBILE' as const };

    expect(SIGNAL_RULES.mobile_number(facts(odd), NICHE)).toBeNull();
  });
});
