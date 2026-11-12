/**
 * Component tests of the expanded lead row, rendered to HTML with react-dom/server (no browser,
 * no testing library): the breakdown, every signal's evidence, 0-point notes, sources and errors.
 *
 * Serves: FR-14 (every point has evidence), FR-30, FR-32; issue #16.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LeadRow } from '@voxflow/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { LeadEvidence } from './lead-evidence';

const lead: LeadRow = {
  id: 'fictional-lead',
  name: 'Fictional Dental',
  area: 'DHA',
  phone: '+923000000001',
  phoneType: 'MOBILE',
  website: 'https://fictional.example/',
  rating: 4.6,
  reviewCount: 3,
  score: 37,
  tier: 'COLD',
  status: 'SCORED',
  failedStep: null,
  error: null,
  breakdown: { pain: 15, fit: 10, reachability: 12, abilityToPay: 0 },
  signals: [
    {
      key: 'phone_unanswered_reviews',
      dimension: 'PAIN',
      points: 15,
      evidence: '2 of the last 3 reviews say the phone goes unanswered',
      sourceUrl: null,
    },
    {
      key: 'mobile_number',
      dimension: 'REACHABILITY',
      points: 12,
      evidence: 'Listing phone ends 0001',
      sourceUrl: 'https://maps.example/fictional',
    },
    {
      key: 'reviews_unreplied',
      dimension: 'PAIN',
      points: 0,
      evidence: 'Only 3 reviews stored, fewer than the 10 needed',
      sourceUrl: null,
    },
  ],
};

// Text only: tags and React's text separators removed, so the test reads what the founder sees.
const textOf = (row: LeadRow) =>
  renderToStaticMarkup(<LeadEvidence lead={row} />)
    .split('<')
    // Each piece is "tag>text": keep the text after the tag.
    .map((piece) => piece.slice(piece.indexOf('>') + 1))
    .join(' ')
    .replaceAll(/\s+/g, ' ');

// Proves FR-14 on screen: each dimension's points and every signal's evidence, 0-point notes too.
describe('LeadEvidence', () => {
  it('shows the score by dimension out of its maximum', () => {
    expect(textOf(lead)).toContain(
      'Pain 15 / 40 Fit 10 / 25 Reachability 12 / 20 Ability to pay 0 / 15',
    );
  });

  it('lists every signal with its points and evidence, highest first, including the 0-point note', () => {
    const text = textOf(lead);

    expect(text).toContain(
      '+15 phone_unanswered_reviews 2 of the last 3 reviews say the phone goes unanswered',
    );
    expect(text.indexOf('+12')).toBeLessThan(text.indexOf('+0'));
    expect(text).toContain('+0 reviews_unreplied Only 3 reviews stored, fewer than the 10 needed');
  });

  it('links a signal to its source in a new tab, and mutes a 0-point note', () => {
    const html = renderToStaticMarkup(<LeadEvidence lead={lead} />);

    expect(html).toContain('href="https://maps.example/fictional"');
    expect(html).toContain('rel="noreferrer"');
    const muted = html.indexOf('<li class="text-slate-500">');
    expect(muted).toBeGreaterThan(-1);
    expect(html.indexOf('Only 3 reviews stored')).toBeGreaterThan(muted);
  });

  it('shows a FAILED lead’s step and error, and says when there is no evidence yet', () => {
    const failed = {
      ...lead,
      status: 'FAILED' as const,
      failedStep: 'LABEL_REVIEWS',
      error: 'Review labelling failed',
      breakdown: null,
      signals: [],
    };

    expect(textOf(failed)).toContain('Failed at LABEL_REVIEWS: Review labelling failed');
    expect(textOf(failed)).toContain('No evidence yet: this lead has not been scored.');
  });
});
