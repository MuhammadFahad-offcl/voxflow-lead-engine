/**
 * Unit tests of the lead table's URL state: known keys only, empty fields dropped, column-heading
 * sort toggles and page links.
 *
 * Serves: FR-30 (filter, sort, paging); issue #16.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { readLeadQuery, sortLink, toSearch } from './lead-query';

// Proves an empty filter field means "any", and unknown keys never reach the API.
describe('readLeadQuery', () => {
  it('keeps known, non-empty keys, trimmed, first of a repeated key', () => {
    expect(
      readLeadQuery({
        tier: 'HOT',
        area: ' DHA ',
        minScore: '',
        colour: 'red',
        status: ['FAILED', 'SCORED'],
      }),
    ).toEqual({ tier: 'HOT', area: 'DHA', status: 'FAILED' });
  });
});

// Proves links keep the filters and change only what they should.
describe('toSearch', () => {
  it('writes the state in a fixed key order, without empty or removed keys', () => {
    expect(toSearch({ page: '2', tier: 'HOT' }, { area: 'DHA', page: undefined })).toBe(
      '?tier=HOT&area=DHA',
    );
    expect(toSearch({})).toBe('');
  });
});

// Proves a heading click sorts by its column, highest first (A–Z for name), then flips.
describe('sortLink', () => {
  it('starts reviews highest first, and flips on a second click', () => {
    expect(sortLink({ tier: 'HOT', page: '3' }, 'reviews')).toBe('?tier=HOT&sort=reviews&dir=desc');
    expect(sortLink({ sort: 'reviews', dir: 'desc' }, 'reviews')).toBe('?sort=reviews&dir=asc');
  });

  it('flips ascending back to descending, and reads a direction set without a sort as score', () => {
    expect(sortLink({ sort: 'reviews', dir: 'asc' }, 'reviews')).toBe('?sort=reviews&dir=desc');
    expect(sortLink({ dir: 'asc' }, 'score')).toBe('?sort=score&dir=desc');
  });

  it('starts name A–Z, and treats the default score sort as already highest first', () => {
    expect(sortLink({}, 'name')).toBe('?sort=name&dir=asc');
    expect(sortLink({}, 'score')).toBe('?sort=score&dir=asc');
  });
});
