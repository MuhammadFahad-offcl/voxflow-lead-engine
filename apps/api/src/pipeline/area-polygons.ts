/**
 * Loads the campaign area polygons and looks them up by city and area name.
 *
 * Serves: FR-2, ADR-0015 (Compass needs a polygon per area; its text location found 0 places).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/worker.ts,
 * apps/api/src/pipeline/area-polygons.spec.ts.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { AreaFile, type AreaPolygon } from '@voxflow/shared';

/** The repo's `config/areas/` folder; the same depth from `src/` and from the compiled `dist/`. */
export const AREAS_DIR = resolve(import.meta.dirname, '../../../../config/areas');

/** Every known polygon, by city and area. */
export type AreaPolygons = ReadonlyMap<string, AreaPolygon>;

// Campaign input keeps its own spelling, so "dha" and "DHA" must reach the same polygon.
const areaKey = (city: string, area: string): string =>
  `${city.trim().toLowerCase()}|${area.trim().toLowerCase()}`;

/**
 * Reads and validates every `.json` file in a folder.
 *
 * Call it before `createApp`: HazelJS swallows errors thrown while it builds providers, and a bad
 * file must stop startup rather than surface in a paid run.
 * @param dir - Folder of area files, normally {@link AREAS_DIR}.
 * @returns The polygons of all cities.
 * @throws ZodError when a file does not match `AreaFile`; SyntaxError when it is not JSON; ENOENT
 * when the folder is missing.
 */
export function loadAreaPolygons(dir: string): AreaPolygons {
  const polygons = new Map<string, AreaPolygon>();
  for (const name of readdirSync(dir).filter((file) => file.endsWith('.json'))) {
    const file = AreaFile.parse(JSON.parse(readFileSync(join(dir, name), 'utf8')));
    for (const area of file.areas) polygons.set(areaKey(file.city, area.name), area.polygon);
  }
  return polygons;
}

/**
 * Finds one area's polygon.
 * @param polygons - The loaded polygons.
 * @param city - Campaign city.
 * @param area - Campaign area.
 * @returns The polygon, or undefined when the area has none.
 */
export function findAreaPolygon(
  polygons: AreaPolygons,
  city: string,
  area: string,
): AreaPolygon | undefined {
  return polygons.get(areaKey(city, area));
}

/**
 * Lists a campaign's areas that have no polygon, so they can be refused before any charge.
 * @param polygons - The loaded polygons.
 * @param city - Campaign city.
 * @param areas - Campaign areas.
 * @returns The areas with no polygon, in their campaign spelling.
 */
export function missingAreas(
  polygons: AreaPolygons,
  city: string,
  areas: readonly string[],
): string[] {
  return areas.filter((area) => findAreaPolygon(polygons, city, area) === undefined);
}
