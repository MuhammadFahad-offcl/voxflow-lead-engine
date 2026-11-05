/**
 * Pure pieces of discovery: the search grid, the note tracking a search, and a place's lead row.
 *
 * Serves: FR-2 (grid), FR-5, FR-6, FR-7; issue #10 (founder decision on Q3).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/pipeline/search-plan.spec.ts.
 */
import { z } from 'zod';
import type { CompassPlaceItem } from '../adapters/lead-source/apify-items.js';
import type { Prisma } from '../generated/prisma/client.js';
import type { CollectedRun } from '../ports/lead-source.port.js';
import { normalizePhone, normalizeUrl } from './normalize.js';

/** One cell of the grid, before it has a run. */
interface GridSearch {
  term: string;
  area: string;
}

const SearchNote = z.object({
  term: z.string(),
  area: z.string(),
  // Null from the reservation until Apify accepts the start: a crash in between leaves this trace.
  runId: z.string().nullable(),
  // OPEN: in use. CHECK_APIFY: paused so the founder can look for its run. ABANDONED: he resumed.
  state: z.enum(['OPEN', 'CHECK_APIFY', 'ABANDONED']).default('OPEN'),
});
/** What a search's `CostRecord.note` holds. */
type SearchNote = z.infer<typeof SearchNote>;

// Compared as a search reads them, so "Dentist" and "dentist " do not pay for the same run twice.
const termKey = (term: string): string => term.trim().toLowerCase();

/**
 * Builds the grid: one search per area per distinct term.
 *
 * Does not repeat a term: the first spelling stays, because a repeat would be a second paid run.
 * @param terms - The niche's search terms.
 * @param areas - The campaign's areas.
 * @returns The searches, area by area, so a pause leaves whole areas done.
 */
export function buildGrid(terms: readonly string[], areas: readonly string[]): GridSearch[] {
  const keys = terms.map(termKey);
  const distinct = terms.filter((term, index) => keys.indexOf(termKey(term)) === index);
  return areas.flatMap((area) => distinct.map((term) => ({ term, area })));
}

/**
 * Identifies a search within its campaign.
 * @param search - Term and area.
 * @returns A key that two different searches can never share.
 */
export function searchKey(search: GridSearch): string {
  return JSON.stringify([search.term, search.area]);
}

/**
 * Writes the note of a search's `CostRecord`, which is what lets a restart find its paid run.
 * @param note - Term, area, Apify run id (null before the start) and, when not OPEN, its state.
 * @returns The text for `CostRecord.note`.
 */
export function searchNote(note: z.input<typeof SearchNote>): string {
  return JSON.stringify(note);
}

/**
 * Reads a `CostRecord.note` back.
 *
 * Does not throw: other APIFY cost records, such as review runs in #12, hold other notes.
 * @param note - The stored note.
 * @returns Term, area, run id and state, or null when the record is not a discovery search.
 */
export function readSearchNote(note: string | null): SearchNote | null {
  if (note === null) return null;
  try {
    return SearchNote.safeParse(JSON.parse(note)).data ?? null;
  } catch {
    return null;
  }
}

// A paid search that went wrong is not paid for again, so resuming must not imply a retry. It says
// "the searches left" because a run refused by an operator's pause is read once more, for free.
const MOVES_ON = 'Nothing re-runs by itself: resuming carries on with the searches left.';

/**
 * Says what is wrong with a collected run, for the pause that follows it.
 *
 * Does not judge a run that lost only some items: those were logged, and the rest are good.
 * @param run - How the run ended.
 * @param search - Its term and area.
 * @returns The text for `Campaign.pauseReason`, or null when the run needs no pause.
 */
export function runProblem(
  run: Pick<CollectedRun, 'items' | 'status' | 'skippedCount'>,
  search: GridSearch,
): string | null {
  const name = `"${search.term}" in ${search.area}`;
  const found = String(run.items.length);
  if (run.status !== 'SUCCEEDED') {
    return `The Apify run for ${name} ended as ${run.status}. Valid places returned: ${found}. ${MOVES_ON}`;
  }
  if (run.items.length > 0) return null;
  if (run.skippedCount > 0) {
    return `All ${String(run.skippedCount)} items of the Apify run for ${name} were invalid, so Compass's fields may have changed. Check that before resuming. ${MOVES_ON}`;
  }
  return `The Apify run for ${name} succeeded but found no places. Check the area's polygon. ${MOVES_ON}`;
}

/**
 * Turns a validated place into a new `Lead` row.
 *
 * Does not apply the ideal-client filter: that needs the whole campaign's names, so it runs last.
 * `rawPlace` is the validated item: `bookingLinks` (#14) and the closed flags stay available there.
 * Does not look for a mobile in `phone` once `phoneUnformatted` gave a valid number.
 * @param place - The validated place.
 * @param owner - Organization and campaign that found it, and the search's area and city.
 * @param owner.organizationId - `Organization.id`.
 * @param owner.campaignId - `Campaign.id`.
 * @param owner.area - The grid area that found it.
 * @param owner.city - The campaign's city, used when the listing gives none.
 * @returns The row to insert.
 */
export function toLeadRow(
  place: CompassPlaceItem,
  owner: { organizationId: string; campaignId: string; area: string; city: string },
): Prisma.LeadCreateManyInput {
  // Both fields, because a bad `phoneUnformatted` says nothing about `phone`.
  const unformatted = normalizePhone(place.phoneUnformatted ?? '');
  const phone = unformatted.e164 === null ? normalizePhone(place.phone ?? '') : unformatted;
  const website = normalizeUrl(place.website ?? '');
  return {
    organizationId: owner.organizationId,
    campaignId: owner.campaignId,
    placeId: place.placeId,
    name: place.title,
    category: place.categoryName,
    address: place.address,
    area: owner.area,
    city: place.city ?? owner.city,
    mapsUrl: place.url,
    rating: place.totalScore,
    reviewCount: place.reviewsCount,
    rawPlace: place as Prisma.InputJsonObject,
    phone: phone.e164,
    phoneType: phone.type,
    website,
    websiteStatus: website === null ? 'NONE' : 'PENDING',
  };
}
