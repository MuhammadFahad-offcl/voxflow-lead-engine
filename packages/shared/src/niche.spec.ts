/**
 * Unit tests of the niche and catalog file schemas against the real config files.
 *
 * Serves: FR-4, FR-14, FR-16, PRD "Lead scoring model".
 * Used by: `pnpm test`, through the `shared` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CatalogFile, NicheFile } from './niche.js';

const config = (path: string): unknown =>
  JSON.parse(
    readFileSync(resolve(import.meta.dirname, '../../../config', path), 'utf8'),
  ) as unknown;

const dental = config('niches/dental-clinic.json') as {
  signalWeights: { PAIN: Record<string, { points: number }> };
};
const catalog = config('catalog/services.json') as { services: Record<string, unknown>[] };

// Proves a niche file must have the 13 PRD signals with points adding up to exactly 100.
describe('NicheFile', () => {
  it('accepts config/niches/dental-clinic.json', () => {
    expect(NicheFile.safeParse(dental).success).toBe(true);
  });

  it('rejects weights that do not add up to 100', () => {
    const heavier = structuredClone(dental);
    // Change only the points: a missing `rule` would fail first and never reach the sum check.
    const signal = heavier.signalWeights.PAIN['phone_unanswered_reviews'];
    if (signal === undefined) throw new Error('fixture lost phone_unanswered_reviews');
    signal.points += 1;

    const result = NicheFile.safeParse(heavier);

    expect(result.error?.issues.map((issue) => issue.message)).toEqual([
      'signal points must add up to 100, so a score is out of 100',
    ]);
  });

  it('rejects an unknown signal key, so a typo cannot score silently', () => {
    // All 13 real keys stay with their points. Zod drops the unknown key before the sum is added
    // up, so the sum is still 100 and the unknown key is the only issue.
    const typo = structuredClone(dental);
    typo.signalWeights.PAIN['phone_unansered_reviews'] = { points: 1, rule: 'typo' } as never;

    const result = NicheFile.safeParse(typo);

    expect(result.error?.issues.map((issue) => issue.code)).toEqual(['unrecognized_keys']);
  });
});

// Proves catalog promises contain no numbers (the founder gives figures) and slugs are unique.
describe('CatalogFile', () => {
  it('accepts config/catalog/services.json', () => {
    expect(CatalogFile.safeParse(catalog).success).toBe(true);
  });

  it('rejects an expected result with Latin or Urdu digits', () => {
    for (const text of ['Saves 20 hours a week', 'ہفتے میں ۲۰ گھنٹے']) {
      const withNumber = structuredClone(catalog);
      withNumber.services[0] = { ...withNumber.services[0], expectedResultUrdu: text };

      expect(CatalogFile.safeParse(withNumber).success).toBe(false);
    }
  });

  it('rejects two services with the same slug', () => {
    const twice = structuredClone(catalog);
    twice.services.push({ ...twice.services[0] });

    expect(CatalogFile.safeParse(twice).success).toBe(false);
  });
});
