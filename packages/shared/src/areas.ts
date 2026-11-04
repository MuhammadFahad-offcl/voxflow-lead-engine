/**
 * Zod schema for a city's area polygons file (config/areas/<city>.json).
 *
 * Serves: FR-2 (search grid), ADR-0015 (one polygon per campaign area).
 * Used by: apps/api/src/pipeline/area-polygons.ts.
 */
import { z } from 'zod';

// GeoJSON order: [longitude, latitude].
const Position = z.tuple([z.number().min(-180).max(180), z.number().min(-90).max(90)]);

// Four points is the smallest closed shape: a triangle plus the repeated first point.
const LinearRing = z
  .array(Position)
  .min(4, 'a ring needs at least 4 points')
  .refine((ring) => {
    const [first, last] = [ring[0], ring.at(-1)];
    return first?.[0] === last?.[0] && first?.[1] === last?.[1];
  }, 'a ring must end where it starts');

/** One GeoJSON polygon with one outer ring: the shape Compass's `customGeolocation` was proved with. */
export const AreaPolygon = z.strictObject({
  type: z.literal('Polygon'),
  coordinates: z.tuple([LinearRing]),
});
/** Parsed area polygon. Shares the schema's name so one import gives both. */
export type AreaPolygon = z.infer<typeof AreaPolygon>;

/** A city's polygons file. `meta` is allowed and not read. */
export const AreaFile = z.strictObject({
  meta: z.unknown().optional(),
  city: z.string().min(1),
  areas: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        // Where the shape came from, so the founder can check it and the licence travels with it.
        source: z.strictObject({
          origin: z.string().min(1),
          osmObject: z.string().nullable(),
          retrievedOn: z.iso.date(),
          licence: z.string().nullable(),
        }),
        polygon: AreaPolygon,
      }),
    )
    .min(1),
});
