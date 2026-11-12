/**
 * Unit tests of the retry rule: a FAILED lead goes back to the status its failed step starts from.
 *
 * Serves: FR-32; issue #15.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { retryStatusFor } from './leads.service.js';

// Proves "retry runs it again from the failed step": labelling and scoring resume ENRICHED.
describe('retryStatusFor', () => {
  it.each([
    ['ENRICH_WEBSITE', 'DISCOVERED'],
    ['ENRICH_CONTEXT', 'DISCOVERED'],
    ['LABEL_REVIEWS', 'ENRICHED'],
    ['SCORE', 'ENRICHED'],
    // An unknown step starts from the beginning; the steps skip what is stored.
    ['ENRICH_REVIEWS', 'DISCOVERED'],
    [null, 'DISCOVERED'],
  ] as const)('sends a lead failed at %s back to %s', (step, status) => {
    expect(retryStatusFor(step)).toBe(status);
  });
});
