/**
 * Turns lead-table rows into the CSV the founder exports: one header line, one line per lead, the
 * top 3 evidence lines in one column. Pure, so its quoting rules are unit-tested.
 *
 * Serves: FR-30 (CSV export of exactly the filtered rows), US-14; issue #16.
 * Used by: apps/api/src/modules/leads/lead-table.service.ts, ./lead-csv.spec.ts.
 */
import type { LeadRow } from '@voxflow/shared';

/** The CSV's columns, in order, as C1-14 lists them. */
const HEADER = [
  'name',
  'area',
  'phone',
  'phone type',
  'website',
  'rating',
  'reviews',
  'score',
  'tier',
  'top 3 evidence',
  'status',
];
const TOP_EVIDENCE = 3;
// A spreadsheet runs a cell that starts with one of these as a formula; business names and review
// quotes come from Google, so a name like "=HYPERLINK(...)" must stay text (CSV injection).
const FORMULA_START = /^[=+\-@\t\r]/;
// A plain signed number, such as an E.164 phone "+923001234567", cannot run as a formula, so it
// keeps its "+". (Excel and Sheets may still show it as a number: format that column as text.)
const PLAIN_NUMBER = /^[+-]?\d+(?:\.\d+)?$/;

/**
 * Makes one value safe for a CSV cell.
 * @param value - The cell's value; null is an empty cell.
 * @returns The value, prefixed with `'` when it would start a formula (a plain signed number such
 * as a phone stays as it is), and quoted when it holds a comma, a quote or a line break (inner
 * quotes doubled).
 */
export function csvCell(value: string | number | null): string {
  if (value === null) return '';
  let text = String(value);
  // Leading spaces too: an importer that trims them would otherwise see the formula.
  const start = text.trimStart();
  const formula = FORMULA_START.test(text) || FORMULA_START.test(start);
  if (typeof value === 'string' && formula && !PLAIN_NUMBER.test(start)) {
    text = `'${text}`;
  }
  // `;` too: in a locale whose separator is `;`, an unquoted one would start a new cell.
  return /[",;\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/**
 * Builds the CSV file for some lead rows.
 *
 * Does not filter or sort: the rows come already filtered and in the table's order.
 * @param leads - The rows; their signals highest points first.
 * @returns The file's text: a UTF-8 byte-order mark first, so Excel on Windows reads Urdu and
 * accented names correctly, then CRLF line ends, as RFC 4180 and spreadsheets expect.
 */
export function toLeadCsv(leads: readonly LeadRow[]): string {
  const lines = leads.map((lead) =>
    [
      lead.name,
      lead.area,
      lead.phone,
      lead.phoneType,
      lead.website,
      lead.rating,
      lead.reviewCount,
      lead.score,
      lead.tier,
      lead.signals
        .slice(0, TOP_EVIDENCE)
        .map((signal) => signal.evidence)
        .join(' | '),
      lead.status,
    ]
      .map(csvCell)
      .join(','),
  );
  return '\uFEFF' + [HEADER.join(','), ...lines].join('\r\n') + '\r\n';
}
