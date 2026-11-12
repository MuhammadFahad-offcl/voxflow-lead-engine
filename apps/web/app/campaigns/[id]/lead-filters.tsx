/**
 * The lead table's filters: a plain GET form, so applying them changes the page's URL and the
 * server renders the filtered page. Empty fields mean "any". The CSV link exports exactly the same
 * filters.
 *
 * Serves: FR-30 (filter by tier, status, area and score range; CSV of the filtered rows), US-14;
 * issue #16.
 * Used by: apps/web/app/campaigns/[id]/page.tsx.
 */
import { toSearch, type LeadQuery } from '../../../lib/lead-query';

const TIERS = ['HOT', 'WARM', 'COLD'];
// The statuses a Cycle 1 lead can have; later ones (calls) come with Cycle 3.
const STATUSES = ['DISCOVERED', 'ENRICHED', 'SCORED', 'FAILED', 'FILTERED_OUT'];

/**
 * Renders the filter form and the CSV link.
 * @param props - The current state.
 * @param props.campaignId - The campaign, for the CSV link.
 * @param props.query - The current filters, shown as the fields' values.
 * @param props.refused - True when the API refused these filters: no export is offered then.
 * @returns The form.
 */
export function LeadFilters({
  campaignId,
  query,
  refused,
}: Readonly<{ campaignId: string; query: LeadQuery; refused: boolean }>) {
  const field = 'rounded border border-slate-300 bg-white px-2 py-1';
  return (
    <form method="get" className="flex flex-wrap items-end gap-3 text-sm">
      <label>
        Tier
        <select name="tier" defaultValue={query.tier ?? ''} className={`${field} ml-1`}>
          <option value="">any</option>
          {TIERS.map((tier) => (
            <option key={tier}>{tier}</option>
          ))}
        </select>
      </label>
      <label>
        Status
        <select name="status" defaultValue={query.status ?? ''} className={`${field} ml-1`}>
          <option value="">any</option>
          {STATUSES.map((status) => (
            <option key={status}>{status}</option>
          ))}
        </select>
      </label>
      <label>
        Area
        <input name="area" defaultValue={query.area ?? ''} className={`${field} ml-1 w-28`} />
      </label>
      <label>
        Score
        <input
          name="minScore"
          aria-label="Minimum score"
          type="number"
          min={0}
          max={100}
          defaultValue={query.minScore ?? ''}
          className={`${field} ml-1 w-16`}
        />
        –
        <input
          name="maxScore"
          aria-label="Maximum score"
          type="number"
          min={0}
          max={100}
          defaultValue={query.maxScore ?? ''}
          className={`${field} w-16`}
        />
      </label>
      {/* The sort survives applying filters; the page goes back to 1. */}
      {query.sort === undefined ? null : <input type="hidden" name="sort" value={query.sort} />}
      {query.dir === undefined ? null : <input type="hidden" name="dir" value={query.dir} />}
      <button type="submit" className="rounded bg-slate-900 px-3 py-1 text-white">
        Apply
      </button>
      {refused ? null : (
        <a
          href={`/campaigns/${campaignId}/export${toSearch(query, { page: undefined })}`}
          className="underline"
        >
          Export CSV
        </a>
      )}
    </form>
  );
}
