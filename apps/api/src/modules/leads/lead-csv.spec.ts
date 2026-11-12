/**
 * Unit tests of the lead CSV: the header and column order, the top 3 evidence lines, quoting, and
 * that a cell can never run as a spreadsheet formula.
 *
 * Serves: FR-30 (CSV export); issue #16.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LeadRow } from '@voxflow/shared';
import { csvCell, toLeadCsv } from './lead-csv.js';

const signal = (points: number, evidence: string) => ({
  key: `signal_${String(points)}`,
  dimension: 'PAIN' as const,
  points,
  evidence,
  sourceUrl: null,
});

const lead: LeadRow = {
  id: 'fictional-lead',
  name: 'Fictional Dental, DHA',
  area: 'DHA',
  phone: '+923000000001',
  phoneType: 'MOBILE',
  website: 'https://fictional.example/',
  rating: 4.6,
  reviewCount: 140,
  score: 74,
  tier: 'HOT',
  status: 'SCORED',
  failedStep: null,
  error: null,
  breakdown: { pain: 30, fit: 25, reachability: 12, abilityToPay: 7 },
  signals: [
    signal(15, '2 of the last 30 reviews say "no one answers"'),
    signal(12, 'Listing phone ends 0001'),
    signal(10, 'Maps category: Dental clinic'),
    signal(8, 'Not in the export'),
  ],
};

// Proves the export has the C1-14 columns and only the 3 strongest evidence lines.
describe('toLeadCsv', () => {
  it('writes the header and one CRLF line per lead, with the top 3 evidence lines joined', () => {
    expect(toLeadCsv([lead]).split('\r\n')).toEqual([
      // The byte-order mark first, so Excel on Windows reads the file as UTF-8.
      '﻿name,area,phone,phone type,website,rating,reviews,score,tier,top 3 evidence,status',
      '"Fictional Dental, DHA",DHA,+923000000001,MOBILE,https://fictional.example/,4.6,140,74,HOT,' +
        '"2 of the last 30 reviews say ""no one answers"" | Listing phone ends 0001 | Maps category: Dental clinic",SCORED',
      '',
    ]);
  });

  it('writes the header alone for no rows, and empty cells for missing values', () => {
    const unscored = { ...lead, area: null, score: null, tier: null, signals: [] };

    expect(toLeadCsv([])).toBe(
      '﻿name,area,phone,phone type,website,rating,reviews,score,tier,top 3 evidence,status\r\n',
    );
    expect(toLeadCsv([unscored]).split('\r\n')[1]).toBe(
      '"Fictional Dental, DHA",,+923000000001,MOBILE,https://fictional.example/,4.6,140,,,,SCORED',
    );
  });
});

// Proves a value from Google can never become a formula, and quoting follows RFC 4180.
describe('csvCell', () => {
  it.each([
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+92 300', "'+92 300"],
    ['-5 stars', "'-5 stars"],
    ['@clinic', "'@clinic"],
    ['line one\nline two', '"line one\nline two"'],
    ['plain', 'plain'],
    // Quoted, so a `;`-separator locale keeps it in one cell.
    ['Fictional; =1+1', '"Fictional; =1+1"'],
    // A formula behind spaces or a tab is still a formula to an importer that trims them.
    [' =1+1', "' =1+1"],
    ['\tcmd', "'\tcmd"],
    // A plain number keeps its "+": it cannot run as a formula.
    ['+923000000001', '+923000000001'],
  ])('writes %j as %j', (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });

  it('leaves numbers alone, so a negative number is not prefixed', () => {
    expect(csvCell(-1)).toBe('-1');
  });
});
