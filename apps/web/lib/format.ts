/**
 * How the dashboard shows times and rates: every time in Pakistan time, whatever the laptop's
 * zone (NFR-13); rates as whole percents.
 *
 * Serves: NFR-13 (times stored in UTC, shown in Asia/Karachi), FR-30; issue #16.
 * Used by: apps/web/app/campaigns/**, apps/web/lib/format.spec.ts.
 */

const KARACHI = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Karachi',
  day: 'numeric',
  month: 'short',
  year: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/**
 * Formats a UTC time for the founder.
 * @param iso - An ISO 8601 time, as the API sends it.
 * @returns Pakistan time, e.g. "12 Nov 2026, 13:20".
 */
export function karachiTime(iso: string): string {
  return KARACHI.format(new Date(iso));
}

/**
 * Formats a 0–1 rate.
 * @param rate - The rate; null when there is nothing to divide yet.
 * @returns A whole percent, e.g. "25%", or "—".
 */
export function percent(rate: number | null): string {
  return rate === null ? '—' : `${String(Math.round(rate * 100))}%`;
}
