/**
 * Unit tests of the search grid, the note that tracks each search, and the lead row of a place.
 *
 * Serves: FR-2, FR-5, FR-6, issue #10 (founder decision on Q3; rawPlace keeps the fields later steps need).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import { CompassPlaceItem } from '../adapters/lead-source/apify-items.js';
import { buildGrid, readSearchNote, searchKey, searchNote, toLeadRow } from './search-plan.js';

const fixture = z
  .array(CompassPlaceItem)
  .parse(
    JSON.parse(
      readFileSync(
        resolve(import.meta.dirname, '../../../../fixtures/places/dental-lahore.json'),
        'utf8',
      ),
    ),
  );
const place = (index: number): CompassPlaceItem => {
  const item = fixture[index];
  if (item === undefined) throw new Error(`No fixture place ${String(index)}`);
  return item;
};
const owner = { organizationId: 'org', campaignId: 'campaign', area: 'DHA', city: 'Lahore' };

// Proves one search per term per area (FR-2), finishing an area before the next.
describe('buildGrid', () => {
  it('crosses areas and terms', () => {
    expect(buildGrid(['a', 'b'], ['X', 'Y'])).toEqual([
      { term: 'a', area: 'X' },
      { term: 'b', area: 'X' },
      { term: 'a', area: 'Y' },
      { term: 'b', area: 'Y' },
    ]);
  });

  it('keeps one search for a repeated term, in its first spelling', () => {
    expect(buildGrid(['Dentist', 'dentist ', 'a', 'a'], ['X'])).toEqual([
      { term: 'Dentist', area: 'X' },
      { term: 'a', area: 'X' },
    ]);
  });
});

// Proves the note survives a round trip, because a restart depends on reading the run id back.
describe('searchNote and readSearchNote', () => {
  const search = { term: 'dental clinic', area: 'DHA', runId: 'run-1' };

  it('reads back what it wrote, as OPEN unless it says otherwise', () => {
    expect(readSearchNote(searchNote(search))).toEqual({ ...search, state: 'OPEN' });
  });

  it('reads back a reservation with no run id yet', () => {
    const reserved = { ...search, runId: null, state: 'CHECK_APIFY' as const };

    expect(readSearchNote(searchNote(reserved))).toEqual(reserved);
  });

  it('keeps term and area readable in the stored text', () => {
    expect(searchNote(search)).toContain('dental clinic');
    expect(searchNote(search)).toContain('DHA');
  });

  it.each([[null], ['free text'], ['{"term":"only"}'], ['[]']])('ignores the note %j', (note) => {
    expect(readSearchNote(note)).toBeNull();
  });

  it('gives one key per term and area, without mixing them up', () => {
    expect(searchKey({ term: 'a b', area: 'c' })).not.toBe(searchKey({ term: 'a', area: 'b c' }));
  });
});

// Proves a stored lead has normalized contacts and keeps its raw place for later steps (FR-6).
describe('toLeadRow', () => {
  it('maps the listing fields', () => {
    expect(toLeadRow(place(0), owner)).toMatchObject({
      organizationId: 'org',
      campaignId: 'campaign',
      placeId: 'fictional-place-p01',
      name: 'Fictional Bright Smile Dental',
      category: 'Dental clinic',
      area: 'DHA',
      city: 'Lahore',
      rating: 4.6,
      reviewCount: 214,
      mapsUrl: 'https://maps.example.com/place/fictional-place-p01',
    });
  });

  it('stores the phone in +92 format with its type', () => {
    const row = toLeadRow(
      { ...place(0), phoneUnformatted: undefined, phone: '0300 0000001' },
      owner,
    );

    expect(row).toMatchObject({ phone: '+923000000001', phoneType: 'MOBILE' });
  });

  it('stores no phone for a junk number, as UNKNOWN', () => {
    const row = toLeadRow({ ...place(0), phoneUnformatted: 'N/A', phone: 'N/A' }, owner);

    expect(row).toMatchObject({ phone: null, phoneType: 'UNKNOWN' });
  });

  it('falls back to the phone field when phoneUnformatted is invalid', () => {
    const row = toLeadRow({ ...place(0), phoneUnformatted: 'N/A', phone: '0300 0000001' }, owner);

    expect(row).toMatchObject({ phone: '+923000000001', phoneType: 'MOBILE' });
  });

  it('takes the first number when the listing gives several', () => {
    const phone = '0300-0000001 / 0321-0000002';

    expect(toLeadRow({ ...place(0), phoneUnformatted: undefined, phone }, owner).phone).toBe(
      '+923000000001',
    );
  });

  it('stores no phone when the listing has none', () => {
    const row = toLeadRow({ ...place(0), phoneUnformatted: undefined, phone: undefined }, owner);

    expect(row).toMatchObject({ phone: null, phoneType: 'UNKNOWN' });
  });

  it('normalizes the website and leaves it for the enrich step to read', () => {
    const row = toLeadRow(
      { ...place(0), website: 'http://p01.example.com/?utm_source=gmb' },
      owner,
    );

    expect(row).toMatchObject({ website: 'https://p01.example.com', websiteStatus: 'PENDING' });
  });

  it.each([[undefined], ['N/A']])('marks website %j as NONE', (website) => {
    expect(toLeadRow({ ...place(0), website }, owner)).toMatchObject({
      website: null,
      websiteStatus: 'NONE',
    });
  });

  it('keeps bookingLinks and the closed flags in rawPlace, for #14 and the closed-place question', () => {
    const closed = { ...place(0), permanentlyClosed: true, temporarilyClosed: true };

    expect(toLeadRow(closed, owner).rawPlace).toMatchObject({
      bookingLinks: [{ name: 'Oladoc', url: 'https://booking.example.com/bright-smile' }],
      permanentlyClosed: true,
      temporarilyClosed: true,
    });
  });
});
