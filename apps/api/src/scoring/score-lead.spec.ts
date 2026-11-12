/**
 * Unit tests of the lead score: points come from the niche profile's weights, the total and
 * breakdown add up, the maximum is 100, and tiers split at the niche's thresholds.
 *
 * Serves: FR-14, FR-15, NFR-9 (≥ 80% coverage of scoring/); issue #14.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { NicheFile } from '@voxflow/shared';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { LeadFacts, NicheRules } from './lead-facts.js';
import { scoreLead, tierFor } from './score-lead.js';

// The real dental-clinic weights, so the "maximum is 100" test checks the seeded profile.
const file = NicheFile.parse(
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../../config/niches/dental-clinic.json'),
      'utf8',
    ),
  ),
);
const DENTAL: NicheRules = {
  signalWeights: file.signalWeights,
  tiers: file.tiers,
  categoryKeywords: file.categoryKeywords,
  premiumAreas: file.premiumAreas,
};

const page = 'https://p01.example.com/';
const labelled = (id: string, label: string, replied: boolean) => ({
  id,
  text: `Fictional review ${id}.`,
  labels: [label],
  ownerReplied: replied,
  publishedAt: new Date('2026-10-01T10:00:00Z'),
});

// A fictional lead with evidence for all 13 signals.
const everything: LeadFacts = {
  reviews: [
    labelled('a', 'PHONE_UNANSWERED', false),
    labelled('b', 'PHONE_UNANSWERED', false),
    labelled('c', 'BOOKING_OR_WAIT', false),
    labelled('d', 'BOOKING_OR_WAIT', true),
    // Six more, so the lead has the 10 stored reviews reviews_unreplied needs.
    ...['e', 'f', 'g', 'h', 'i', 'j'].map((id) => labelled(id, 'OTHER', false)),
  ],
  reviewCount: 140,
  category: 'Dental clinic',
  website: page,
  websiteStatus: 'READ_FETCH',
  hasOnlineBooking: false,
  websiteEvidence: {
    doctors: ['Dr. Fictional A', 'Dr. Fictional B'],
    treatments: [],
    onlineBooking: [],
    chatWidgets: [],
    pagesRead: [page],
  },
  listingBookingLinks: [],
  phone: '+923000000001',
  phoneType: 'MOBILE',
  whatsappLinks: ['https://wa.me/923000000001'],
  socialLinks: ['https://instagram.com/fictional-clinic'],
  decisionMakerName: 'Dr. Fictional A',
  area: 'DHA',
  businessContext: null,
};
const nothing: LeadFacts = {
  ...everything,
  reviews: [],
  reviewCount: 3,
  category: null,
  website: null,
  websiteStatus: 'UNREADABLE',
  hasOnlineBooking: null,
  websiteEvidence: null,
  listingBookingLinks: ['https://oladoc.example/x'],
  phone: null,
  phoneType: 'UNKNOWN',
  whatsappLinks: [],
  socialLinks: [],
  decisionMakerName: null,
  area: 'Fictional Town',
};

// Proves the PRD tiers at their boundaries: hot ≥ 70, warm 45–69, cold < 45.
describe('tierFor', () => {
  it.each([
    [44, 'COLD'],
    [45, 'WARM'],
    [69, 'WARM'],
    [70, 'HOT'],
    [0, 'COLD'],
    [100, 'HOT'],
  ] as const)('puts %i in %s', (total, tier) => {
    expect(tierFor(total, DENTAL.tiers)).toBe(tier);
  });

  it('uses the niche thresholds, not fixed numbers', () => {
    expect(tierFor(60, { hot: 60, warm: 30 })).toBe('HOT');
  });
});

// Proves the score is the sum of the weights of the signals with evidence, out of 100.
describe('scoreLead', () => {
  it('gives the maximum of 100, HOT, when every signal has evidence', () => {
    const result = scoreLead(everything, DENTAL);

    expect(result.total).toBe(100);
    expect(result.breakdown).toEqual({ pain: 40, fit: 25, reachability: 20, abilityToPay: 15 });
    expect(result.tier).toBe('HOT');
    expect(result.signals).toHaveLength(13);
    expect(result.signals.every((signal) => signal.evidence.trim() !== '')).toBe(true);
  });

  it('gives 0 and COLD when nothing has evidence; only the 0-point review note is kept', () => {
    expect(scoreLead(nothing, DENTAL)).toEqual({
      signals: [
        {
          key: 'reviews_unreplied',
          dimension: 'PAIN',
          points: 0,
          evidence: 'No reviews stored, fewer than the 10 needed',
          sourceUrl: null,
          reviewId: null,
        },
      ],
      total: 0,
      breakdown: { pain: 0, fit: 0, reachability: 0, abilityToPay: 0 },
      tier: 'COLD',
    });
  });

  it('takes each point value from the niche weights, with its dimension and evidence', () => {
    const lighter: NicheRules = {
      ...DENTAL,
      signalWeights: {
        ...DENTAL.signalWeights,
        FIT: { ...DENTAL.signalWeights.FIT, many_reviews: { points: 3 } },
      },
    };

    const signal = scoreLead(everything, lighter).signals.find((s) => s.key === 'many_reviews');

    expect(signal).toEqual({
      key: 'many_reviews',
      dimension: 'FIT',
      points: 3,
      evidence: 'Google reviews: 140',
      sourceUrl: null,
      reviewId: null,
    });
  });

  it('counts a signal once however many times its evidence appears', () => {
    const many = { ...everything, whatsappLinks: ['https://wa.me/1', 'https://wa.me/2'] };

    const whatsapp = scoreLead(many, DENTAL).signals.filter((s) => s.key === 'whatsapp_link');

    expect(whatsapp).toHaveLength(1);
    expect(whatsapp[0]?.points).toBe(4);
  });

  it('keeps the review id of a review signal', () => {
    const signal = scoreLead(everything, DENTAL).signals.find(
      (s) => s.key === 'phone_unanswered_reviews',
    );

    expect(signal).toMatchObject({ points: 15, reviewId: 'a' });
  });

  it('keeps a 0-point finding with 0 points: it explains the lead, it adds nothing', () => {
    const few = { ...everything, reviews: everything.reviews.slice(0, 9) };

    const result = scoreLead(few, DENTAL);

    expect(result.signals.find((s) => s.key === 'reviews_unreplied')).toMatchObject({
      points: 0,
      evidence: 'Only 9 reviews stored, fewer than the 10 needed',
    });
    expect(result.total).toBe(93);
    expect(result.breakdown.pain).toBe(33);
  });

  it('refuses a weight for a signal it has no rule for', () => {
    const odd: NicheRules = {
      ...DENTAL,
      signalWeights: { ...DENTAL.signalWeights, FIT: { fictional_signal: { points: 1 } } },
    };

    expect(() => scoreLead(everything, odd)).toThrow('No scoring rule for signal fictional_signal');
  });
});
