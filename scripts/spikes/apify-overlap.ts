/**
 * Spike for #9: compares the places that both actors found in their pass-1 runs, from the raw files
 * apify-compare.ts saved. Answers whether Scraperlink omits listing booking links that Compass returns.
 *
 * Serves: ADR-0010, the founder's no_online_booking rule on #14 (issue #9). Not app code.
 * Used by: the founder, once, on the laptop:
 *   pnpm exec tsx scripts/spikes/apify-overlap.ts <pass1-compass.json> <pass1-scraperlink.json>
 * Prints counts only: no names, phones, addresses or links, so the output is safe to paste.
 */
import { readFile } from 'node:fs/promises';
import process from 'node:process';

type Json = Record<string, unknown>;

const BOOKING_KEYS = [
  'bookingLinks',
  'reserveTableUrl',
  'tableReservationLinks',
  'reservationLinks',
];

const isFilled = (value: unknown): boolean => {
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.trim() !== '';
  return value !== null && typeof value === 'object';
};

// Per place: which booking keys exist at all (even empty) and whether any is filled.
const load = async (path: string) => {
  const run = JSON.parse(await readFile(path, 'utf8')) as { items?: Json[] };
  const places = new Map<string, { booking: boolean; website: boolean }>();
  const keysSeen = new Set<string>();
  for (const item of run.items ?? []) {
    const id = item['placeId'];
    if (typeof id !== 'string' || id === '') continue;
    BOOKING_KEYS.filter((key) => key in item).forEach((key) => keysSeen.add(key));
    places.set(id, {
      booking: BOOKING_KEYS.some((key) => isFilled(item[key])),
      website: isFilled(item['website']),
    });
  }
  return { places, keysSeen };
};

const [compassPath, scraperlinkPath] = process.argv.slice(2);
if (compassPath === undefined || scraperlinkPath === undefined) {
  process.stderr.write(
    'Usage: pnpm exec tsx scripts/spikes/apify-overlap.ts <pass1-compass.json> <pass1-scraperlink.json>\n',
  );
  process.exit(1);
}
const compass = await load(compassPath);
const scraperlink = await load(scraperlinkPath);
const shared = [...compass.places.keys()].filter((id) => scraperlink.places.has(id));
const count = (ids: string[], test: (id: string) => boolean) => ids.filter(test).length;

const lines = [
  `Compass places: ${String(compass.places.size)}; Scraperlink places: ${String(scraperlink.places.size)}; found by both: ${String(shared.length)}`,
  `Booking keys present in items: Compass [${[...compass.keysSeen].join(', ')}]; Scraperlink [${[...scraperlink.keysSeen].join(', ')}]`,
  `Among places found by both:`,
  `  booking link per Compass: ${String(count(shared, (id) => compass.places.get(id)?.booking === true))}`,
  `  booking link per Scraperlink: ${String(count(shared, (id) => scraperlink.places.get(id)?.booking === true))}`,
  `  Compass has one, Scraperlink does not: ${String(count(shared, (id) => compass.places.get(id)?.booking === true && scraperlink.places.get(id)?.booking !== true))}`,
  `  website per Compass / Scraperlink: ${String(count(shared, (id) => compass.places.get(id)?.website === true))} / ${String(count(shared, (id) => scraperlink.places.get(id)?.website === true))}`,
];
process.stdout.write(lines.join('\n') + '\n');
