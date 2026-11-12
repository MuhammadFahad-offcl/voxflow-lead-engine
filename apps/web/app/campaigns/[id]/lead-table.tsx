/**
 * The lead table of a campaign page: one row per lead, sortable column headings, and each row
 * expanding (native `<details>`, no client script) to its evidence. FAILED rows carry a Retry
 * button.
 *
 * Serves: FR-30 (lead table: sort, expand to evidence), FR-14, FR-32 (retry); issue #16.
 * Used by: apps/web/app/campaigns/[id]/page.tsx.
 */
import type { LeadPage } from '@voxflow/shared';
import Link from 'next/link';
import { sortLink, type LeadQuery } from '../../../lib/lead-query';
import { retryLead } from './actions';
import { LeadEvidence } from './lead-evidence';

// Name, area, phone, reviews, score, tier, status.
const COLUMNS = 'grid grid-cols-[2fr_1fr_1.2fr_0.7fr_0.6fr_0.6fr_1fr] gap-2 px-4 py-2';
const TIER_COLOURS = { HOT: 'text-red-700', WARM: 'text-amber-700', COLD: 'text-slate-500' };

/**
 * Renders the table.
 * @param props - The page of leads and the URL state.
 * @param props.campaignId - The campaign, for the Retry action.
 * @param props.page - One page of leads from the API.
 * @param props.query - The current filters and sort, for the heading links.
 * @returns The table, or a line saying no lead matches.
 */
export function LeadTable({
  campaignId,
  page,
  query,
}: Readonly<{ campaignId: string; page: LeadPage; query: LeadQuery }>) {
  if (page.leads.length === 0) return <p className="py-6 text-slate-600">No lead matches.</p>;
  const heading = (label: string, sort?: 'score' | 'name' | 'reviews') =>
    sort === undefined ? (
      <span>{label}</span>
    ) : (
      <Link href={sortLink(query, sort)} className="underline">
        {label}
      </Link>
    );
  return (
    <div className="border bg-white text-sm">
      <div className={`${COLUMNS} border-b font-medium text-slate-600`}>
        {heading('Name', 'name')}
        {heading('Area')}
        {heading('Phone')}
        {heading('Reviews', 'reviews')}
        {heading('Score', 'score')}
        {heading('Tier')}
        {heading('Status')}
      </div>
      {page.leads.map((lead) => (
        <details key={lead.id} className="border-b last:border-0">
          <summary className={`${COLUMNS} cursor-pointer hover:bg-slate-50`}>
            <span className="font-medium">{lead.name}</span>
            <span>{lead.area ?? '—'}</span>
            <span>{lead.phone ?? '—'}</span>
            <span>{lead.reviewCount ?? '—'}</span>
            <span className="font-semibold">{lead.score ?? '—'}</span>
            <span className={lead.tier === null ? '' : TIER_COLOURS[lead.tier]}>
              {lead.tier ?? '—'}
            </span>
            <span>
              {lead.status}
              {lead.status === 'FAILED' ? (
                <form action={retryLead.bind(null, campaignId, lead.id)} className="inline">
                  <button
                    type="submit"
                    className="ml-2 rounded border px-2 text-xs hover:bg-slate-100"
                  >
                    Retry
                  </button>
                </form>
              ) : null}
            </span>
          </summary>
          <LeadEvidence lead={lead} />
        </details>
      ))}
    </div>
  );
}
