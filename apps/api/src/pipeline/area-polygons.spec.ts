/**
 * Unit tests of the area polygons file and of the lookup the discover step makes before paying.
 *
 * Serves: FR-2, ADR-0015, issue #10 (an area with no polygon is refused before any charge).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ZodError } from 'zod';
import { AREAS_DIR, findAreaPolygon, loadAreaPolygons, missingAreas } from './area-polygons.js';

const polygons = loadAreaPolygons(AREAS_DIR);

const dirWith = (content: string): string => {
  const dir = mkdtempSync(join(tmpdir(), 'areas-'));
  writeFileSync(join(dir, 'city.json'), content);
  return dir;
};

const areaFile = (ring: number[][]): string =>
  JSON.stringify({
    city: 'Fictional City',
    areas: [
      {
        name: 'Fictional Area',
        source: { origin: 'Fictional', osmObject: null, retrievedOn: '2026-11-05', licence: null },
        polygon: { type: 'Polygon', coordinates: [ring] },
      },
    ],
  });

// Proves the committed file loads and DHA keeps the box that found 20 places in the #9 spike.
describe('config/areas', () => {
  it('holds the spike box for DHA, Lahore', () => {
    expect(findAreaPolygon(polygons, 'Lahore', 'DHA')?.coordinates[0]).toEqual([
      [74.37, 31.43],
      [74.47, 31.43],
      [74.47, 31.51],
      [74.37, 31.51],
      [74.37, 31.43],
    ]);
  });

  it.each([
    ['Model Town', 92],
    ['Bahria Town', 180],
  ])('holds the OpenStreetMap ring of %s, inside Lahore', (area, points) => {
    const ring = findAreaPolygon(polygons, 'Lahore', area)?.coordinates[0] ?? [];

    expect(ring).toHaveLength(points);
    expect(ring.every(([lng, lat]) => lng > 74.1 && lng < 74.6 && lat > 31.3 && lat < 31.7)).toBe(
      true,
    );
  });

  it('has no made-up shape for the two areas OpenStreetMap has no boundary for', () => {
    expect(missingAreas(polygons, 'Lahore', ['Cantt', 'Garden Town'])).toEqual([
      'Cantt',
      'Garden Town',
    ]);
  });
});

// Proves a lookup ignores case and spacing, and says which areas have no polygon.
describe('findAreaPolygon and missingAreas', () => {
  it('finds an area whatever its case', () => {
    expect(findAreaPolygon(polygons, ' lahore ', 'dha')).toBeDefined();
  });

  it('does not find an unknown area, or a known area in another city', () => {
    expect(findAreaPolygon(polygons, 'Lahore', 'Fictional Area')).toBeUndefined();
    expect(findAreaPolygon(polygons, 'Karachi', 'DHA')).toBeUndefined();
  });

  it('names only the areas with no polygon', () => {
    expect(missingAreas(polygons, 'Lahore', ['DHA', 'Fictional Area'])).toEqual(['Fictional Area']);
  });
});

// Proves bad boundary data stops at load, not in a paid run.
describe('loadAreaPolygons validation', () => {
  it('accepts a closed ring', () => {
    const ring = [
      [74, 31],
      [75, 31],
      [75, 32],
      [74, 31],
    ];

    const loaded = loadAreaPolygons(dirWith(areaFile(ring)));

    expect(findAreaPolygon(loaded, 'Fictional City', 'Fictional Area')).toBeDefined();
  });

  it('refuses a ring that does not end where it starts', () => {
    const ring = [
      [74, 31],
      [75, 31],
      [75, 32],
      [74, 32],
    ];

    expect(() => loadAreaPolygons(dirWith(areaFile(ring)))).toThrow(ZodError);
  });

  it('refuses a ring of fewer than 4 points', () => {
    const ring = [
      [74, 31],
      [75, 31],
      [74, 31],
    ];

    expect(() => loadAreaPolygons(dirWith(areaFile(ring)))).toThrow(ZodError);
  });

  it('refuses coordinates outside the globe', () => {
    const ring = [
      [274, 31],
      [75, 31],
      [75, 32],
      [274, 31],
    ];

    expect(() => loadAreaPolygons(dirWith(areaFile(ring)))).toThrow(ZodError);
  });
});
