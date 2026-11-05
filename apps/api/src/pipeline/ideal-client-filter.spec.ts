/**
 * Unit tests of the ideal-client filter, rule by rule, plus the fixture's expected outcome.
 *
 * Serves: FR-8, issue #10 (the 4.0 / 30-review boundary clinic must pass).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NicheFile } from '@voxflow/shared';
import { z } from 'zod';
import { CompassPlaceItem } from '../adapters/lead-source/apify-items.js';
import {
  countChainNames,
  idealClientFilter,
  normalizeName,
  type FilterablePlace,
} from './ideal-client-filter.js';

const repoFile = (path: string): unknown =>
  JSON.parse(readFileSync(resolve(import.meta.dirname, '../../../..', path), 'utf8'));

const rules = NicheFile.parse(repoFile('config/niches/dental-clinic.json')).idealClient;
const noChains: ReadonlyMap<string, number> = new Map();

const place = (overrides: Partial<FilterablePlace> = {}): FilterablePlace => ({
  title: 'Fictional Bright Smile Dental',
  categoryName: 'Dental clinic',
  categories: ['Dental clinic', 'Dentist'],
  totalScore: 4.6,
  reviewsCount: 214,
  ...overrides,
});

// Proves an ordinary private clinic is kept.
describe('idealClientFilter: pass', () => {
  it('passes a private clinic above every minimum', () => {
    expect(idealClientFilter(place(), rules, noChains)).toEqual({ pass: true });
  });
});

// Proves "at least" means at least: the minimums themselves pass, one step below does not (FR-8).
describe('idealClientFilter: rating and review boundaries', () => {
  it('passes a clinic at exactly 4.0 stars and 30 reviews', () => {
    const boundary = place({ totalScore: 4.0, reviewsCount: 30 });

    expect(idealClientFilter(boundary, rules, noChains)).toEqual({ pass: true });
  });

  it('drops a clinic at 3.9 stars and gives the rule', () => {
    expect(idealClientFilter(place({ totalScore: 3.9 }), rules, noChains)).toEqual({
      pass: false,
      reason: 'rating 3.9 is below the minimum 4',
    });
  });

  it('drops a clinic at 29 reviews and gives the rule', () => {
    expect(idealClientFilter(place({ reviewsCount: 29 }), rules, noChains)).toEqual({
      pass: false,
      reason: '29 reviews is below the minimum 30',
    });
  });

  it('treats a place with no rating as below the minimum', () => {
    expect(idealClientFilter(place({ totalScore: null }), rules, noChains)).toEqual({
      pass: false,
      reason: 'no rating',
    });
  });
});

// Proves hospitals and institutions are dropped by name, on whole words only (FR-8).
describe('idealClientFilter: name keywords', () => {
  it('drops a name holding a keyword, in any case', () => {
    expect(idealClientFilter(place({ title: 'City HOSPITAL Dental' }), rules, noChains)).toEqual({
      pass: false,
      reason: 'name contains "hospital"',
    });
  });

  it('matches a two-word keyword across punctuation', () => {
    const title = 'Fictional Medical-Complex Dental';

    expect(idealClientFilter(place({ title }), rules, noChains)).toEqual({
      pass: false,
      reason: 'name contains "medical complex"',
    });
  });

  it('keeps a clinic whose name only contains a keyword inside a longer word', () => {
    const title = 'Fictional Trusted Smiles Dental';

    expect(idealClientFilter(place({ title }), rules, noChains)).toEqual({ pass: true });
  });
});

// Proves a hospital listed under a clinic-like name is still not a private clinic (FR-8).
describe('idealClientFilter: privateClinicOnly', () => {
  const hospital = place({ categoryName: 'Hospital', categories: ['Hospital', 'Dentist'] });

  it('drops a place whose main category is an excluded word', () => {
    expect(idealClientFilter(hospital, rules, noChains)).toEqual({
      pass: false,
      reason: 'not a private clinic: category "Hospital"',
    });
  });

  it('drops a place with an excluded word in a secondary category', () => {
    const categories = ['Dentist', 'University hospital'];

    expect(idealClientFilter(place({ categories }), rules, noChains)).toEqual({
      pass: false,
      reason: 'not a private clinic: category "University hospital"',
    });
  });

  it('does not apply when the niche turns it off', () => {
    const open = { ...rules, privateClinicOnly: false };

    expect(idealClientFilter(hospital, open, noChains)).toEqual({ pass: true });
  });
});

// Proves the chain rule: 3 or more places with one normalized name in a campaign (FR-8).
describe('idealClientFilter: chains', () => {
  const name = 'fictional bright smile dental';

  it('keeps a name seen twice', () => {
    expect(idealClientFilter(place(), rules, new Map([[name, 2]]))).toEqual({ pass: true });
  });

  it('drops a name seen 3 times', () => {
    expect(idealClientFilter(place(), rules, new Map([[name, 3]]))).toEqual({
      pass: false,
      reason: 'chain: 3 places with this name in the campaign',
    });
  });

  it('matches the count despite case and punctuation in the place name', () => {
    const title = '  FICTIONAL  Bright-Smile  Dental. ';

    expect(idealClientFilter(place({ title }), rules, new Map([[name, 3]])).pass).toBe(false);
  });

  it('does not apply when the niche turns it off', () => {
    const open = { ...rules, excludeChains: false };

    expect(idealClientFilter(place(), open, new Map([[name, 9]]))).toEqual({ pass: true });
  });
});

// Proves chain counts come from names, so a repeated place or a spelling change cannot split them.
describe('normalizeName and countChainNames', () => {
  it('lowercases, drops punctuation and collapses spaces', () => {
    expect(normalizeName("  Dr.  Ali's   Dental-Care ")).toBe('dr ali s dental care');
  });

  it('keeps Urdu letters', () => {
    expect(normalizeName('ڈینٹل کلینک')).toBe('ڈینٹل کلینک');
  });

  it('counts each normalized name once per place', () => {
    const counts = countChainNames(['Smile Dental', 'SMILE-dental', 'Other Clinic']);

    expect(counts.get('smile dental')).toBe(2);
    expect(counts.get('other clinic')).toBe(1);
  });
});

// Proves the fixture's numbers from issue #10: of 11 distinct places, exactly the 2 named ones go.
describe('idealClientFilter on the fixture', () => {
  const items = z.array(CompassPlaceItem).parse(repoFile('fixtures/places/dental-lahore.json'));
  const distinct = [...new Map(items.map((item) => [item.placeId, item])).values()];
  const chains = countChainNames(distinct.map((item) => item.title));
  const dropped = distinct.filter((item) => !idealClientFilter(item, rules, chains).pass);

  it('drops only the hospital and the 3.6 clinic', () => {
    expect(dropped.map((item) => item.placeId)).toEqual([
      'fictional-place-p04',
      'fictional-place-p05',
    ]);
  });

  it('keeps the boundary clinic at 4.0 stars and 30 reviews', () => {
    const boundary = distinct.find((item) => item.placeId === 'fictional-place-p11');

    expect(boundary).toMatchObject({ totalScore: 4, reviewsCount: 30 });
    expect(dropped).not.toContainEqual(boundary);
  });
});
