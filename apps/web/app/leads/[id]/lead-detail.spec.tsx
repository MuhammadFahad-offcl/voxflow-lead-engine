/**
 * Component tests of the lead page, rendered to HTML with react-dom/server: one describe per lead
 * state (a pick, a pick citing a signal that is gone, NO_STRONG_SIGNAL, NEEDS_REVIEW, COLD,
 * FILTERED_OUT), plus the header and the reviews.
 *
 * Serves: FR-30 (lead detail), FR-17, US-5; issue #24.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LeadDetail } from '@voxflow/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeadDetailView } from './lead-detail';

const solution = {
  serviceSlug: 'missed-call-whatsapp-reply',
  serviceName: 'Missed-call WhatsApp reply',
  reason: 'Patients say nobody answers the phone.',
  model: 'claude-haiku-5-5',
  signalIds: ['sig-phone'],
};

const picked: LeadDetail = {
  id: 'fictional-lead',
  campaignId: 'fictional-campaign',
  name: 'Fictional Dental',
  area: 'DHA',
  phone: '+923000000001',
  phoneType: 'MOBILE',
  website: 'https://fictional.example/',
  rating: 4.2,
  reviewCount: 3,
  score: 61,
  tier: 'WARM',
  status: 'READY_TO_CALL',
  failedStep: null,
  error: null,
  filterReason: null,
  breakdown: { pain: 25, fit: 16, reachability: 20, abilityToPay: 0 },
  signals: [
    {
      id: 'sig-phone',
      key: 'phone_unanswered_reviews',
      dimension: 'PAIN',
      points: 15,
      evidence: '2 of 3 reviews say nobody answers the phone',
      sourceUrl: null,
    },
    {
      id: 'sig-mobile',
      key: 'mobile_number',
      dimension: 'REACHABILITY',
      points: 12,
      evidence: 'Listing phone is a mobile number',
      sourceUrl: null,
    },
  ],
  reviews: [
    {
      id: 'rev-1',
      text: 'Called three times, no answer.',
      rating: 2,
      publishedAt: '2026-11-01T09:00:00.000Z',
      ownerReplied: false,
      labels: ['PHONE_UNANSWERED'],
    },
    {
      id: 'rev-2',
      text: 'Good doctor.',
      rating: null,
      publishedAt: null,
      ownerReplied: true,
      labels: [],
    },
  ],
  solution,
};

/**
 * The same lead with no Solution, in another state.
 * @param changes - The fields that differ, e.g. its status.
 * @returns The lead.
 */
const unpicked = (changes: Partial<LeadDetail>): LeadDetail => ({
  ...picked,
  solution: null,
  ...changes,
});

const html = (lead: LeadDetail) => renderToStaticMarkup(<LeadDetailView lead={lead} />);
// Text only: tags removed and spaces collapsed, so the test reads what the founder sees.
const textOf = (lead: LeadDetail) =>
  html(lead)
    .split('<')
    .map((piece) => piece.slice(piece.indexOf('>') + 1))
    .join(' ')
    .replaceAll(/\s+/g, ' ');

// Proves FR-17 on screen: the chosen service, its reason, cited evidence and model; cited signal highlighted.
describe('a WARM or HOT lead with a Solution', () => {
  it('shows the service card with the reason, the cited evidence and the model', () => {
    const text = textOf(picked);

    expect(text).toContain('Missed-call WhatsApp reply');
    expect(text).toContain('Patients say nobody answers the phone.');
    expect(text).toContain('phone_unanswered_reviews 2 of 3 reviews say nobody answers the phone');
    expect(text).toContain('Picked by claude-haiku-5-5');
  });

  it('highlights only the cited signal in the evidence list', () => {
    expect(textOf(picked).match(/cited by the pick/g)).toHaveLength(1);
    expect(textOf(picked)).toContain(
      'cited by the pick 2 of 3 reviews say nobody answers the phone',
    );
  });

  it('shows no script block or placeholder', () => {
    expect(textOf(picked).toLowerCase()).not.toContain('script');
  });
});

// Proves the re-score case (comment on #20): a cited id that is gone is named, not a crash.
describe('a Solution citing a signal that no longer exists', () => {
  it('shows "Signal no longer available" for it and still shows the pick', () => {
    const text = textOf({
      ...picked,
      solution: { ...solution, signalIds: ['sig-gone', 'sig-phone'] },
    });

    expect(text).toContain('Signal no longer available');
    expect(text).toContain('Missed-call WhatsApp reply');
    expect(text.match(/cited by the pick/g)).toHaveLength(1);
  });
});

// Proves FR-17's exit statuses: each says why there is no pick, without inventing the agent's reason.
describe('a lead with no Solution', () => {
  it('NO_STRONG_SIGNAL: says the agent found no evidence-backed problem', () => {
    const text = textOf(unpicked({ status: 'NO_STRONG_SIGNAL' }));

    expect(text).toContain(
      'No service picked: the solution agent found no evidence-backed problem to pitch.',
    );
    expect(text).not.toContain('Picked by');
  });

  it('NEEDS_REVIEW: says the answer failed the checks twice', () => {
    expect(textOf(unpicked({ status: 'NEEDS_REVIEW' }))).toContain(
      'failed the catalog and signal checks twice, so this lead needs your review',
    );
  });

  it('COLD: says COLD leads stop after scoring', () => {
    expect(textOf(unpicked({ status: 'SCORED', tier: 'COLD' }))).toContain(
      'No service picked: COLD leads stop after scoring.',
    );
  });

  it('FILTERED_OUT: gives the filter reason, and no evidence yet', () => {
    const text = textOf(
      unpicked({
        status: 'FILTERED_OUT',
        tier: null,
        score: null,
        breakdown: null,
        signals: [],
        filterReason: 'Fictional: not a dental clinic',
      }),
    );

    expect(text).toContain(
      'ideal-client filter dropped this lead (Fictional: not a dental clinic)',
    );
    expect(text).toContain('No evidence yet');
  });
});

// Proves the header and reviews: contact facts, score, and reviews without authors.
describe('the header and reviews', () => {
  it('shows name, area, phone with type, website link, score, tier and status', () => {
    const text = textOf(picked);

    expect(text).toContain('Fictional Dental');
    expect(text).toContain('DHA · +923000000001 (mobile)');
    expect(text).toContain('Score 61 · Tier WARM · Status READY_TO_CALL');
    expect(html(picked)).toContain('href="https://fictional.example/"');
    expect(html(picked)).toContain('href="/campaigns/fictional-campaign"');
  });

  it('never links a javascript: website', () => {
    const hostile = html({ ...picked, website: 'javascript:alert(1)' });

    expect(hostile).not.toContain('href="javascript:');
  });

  it('lists each review with rating, Pakistan date, owner reply and labels; undated last', () => {
    const text = textOf(picked);

    expect(text).toContain('Reviews (2 stored)');
    expect(text).toContain('2 / 5 · 1 Nov 2026, 14:00 · No owner reply · PHONE_UNANSWERED');
    expect(text).toContain('No rating · Undated · Owner replied');
    expect(text.indexOf('Called three times')).toBeLessThan(text.indexOf('Good doctor'));
  });

  it('says when no reviews are stored', () => {
    expect(textOf({ ...picked, reviews: [] })).toContain('No reviews stored.');
  });

  it('says when a review has no text', () => {
    const [first] = picked.reviews;
    if (first === undefined) throw new Error('fixture lost its reviews');

    expect(textOf({ ...picked, reviews: [{ ...first, text: '' }] })).toContain('No review text.');
  });
});
