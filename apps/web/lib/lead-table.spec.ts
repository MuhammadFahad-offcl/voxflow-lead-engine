/**
 * Unit tests of the campaign page's rules: refused-filter messages, retry answers, and when the
 * page keeps refreshing.
 *
 * Serves: FR-30, FR-32, US-14; issue #16.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LeadPage } from '@voxflow/shared';
import { checkRetry, refusalMessages, shouldRefresh } from './lead-table';

const page = (statuses: LeadPage['leads'][number]['status'][]): LeadPage => ({
  total: statuses.length,
  page: 1,
  pageSize: 50,
  leads: statuses.map((status, index) => ({
    id: `lead${String(index)}`,
    name: 'Fictional Clinic',
    area: null,
    phone: null,
    phoneType: 'UNKNOWN',
    website: null,
    rating: null,
    reviewCount: null,
    score: null,
    tier: null,
    status,
    failedStep: null,
    error: null,
    breakdown: null,
    signals: [],
  })),
});

// Proves a refused filter is explained, not a broken page.
describe('refusalMessages', () => {
  it('lists each field with its message, or says the filters are not valid', () => {
    const body = {
      errors: [{ field: 'minScore', messages: ['minScore must not be above maxScore'] }],
    };

    expect(refusalMessages(body)).toEqual(['minScore: minScore must not be above maxScore']);
    expect(refusalMessages({ message: 'Bad Request' })).toEqual(['These filters are not valid.']);
  });
});

// Proves FR-32's retry reports a real failure, and treats "already retried" as done.
describe('checkRetry', () => {
  it('accepts 200 and 409, and throws an ApiError for 404 or 500', () => {
    expect(() => {
      checkRetry(200, null);
    }).not.toThrow();
    expect(() => {
      checkRetry(409, null);
    }).not.toThrow();
    expect(() => {
      checkRetry(404, null);
    }).toThrow('The API answered 404');
    expect(() => {
      checkRetry(500, null);
    }).toThrow('The API answered 500');
  });
});

// Proves the page refreshes while work is in flight, including a lead retried after the campaign
// finished enriching, and stops once nothing is left.
describe('shouldRefresh', () => {
  it('refreshes while the campaign discovers or enriches', () => {
    expect(shouldRefresh('ENRICHING', page(['SCORED']))).toBe(true);
    expect(shouldRefresh('DISCOVERING', [])).toBe(true);
  });

  it('refreshes a SCORING campaign while a lead on the page is waiting for the worker', () => {
    expect(shouldRefresh('SCORING', page(['SCORED', 'ENRICHED']))).toBe(true);
    expect(shouldRefresh('SCORING', page(['SCORED', 'FAILED', 'FILTERED_OUT']))).toBe(false);
    expect(shouldRefresh('SCORING', ['tier: Invalid option'])).toBe(false);
  });
});
