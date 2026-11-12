/**
 * The lead table of a campaign page: one row per lead, sortable column headings, and each row
 * expanding (native `<details>`, no client script) to its evidence. A FAILED row's Retry button is
 * in its expanded part: a form may not sit inside `<summary>`.
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
  const sorted = query.sort ?? 'score';
  const direction = query.dir ?? (sorted === 'name' ? 'asc' : 'desc');
  const arrow = direction === 'asc' ? ' ▲' : ' ▼';
  const heading = (label: string, sort?: 'score' | 'name' | 'reviews') => {
    if (sort === undefined) return <span>{label}</span>;
    const active = sorted === sort;
    return (
      <Link href={sortLink(query, sort)} className="underline">
        {label}
        {active ? arrow : null}
        {active ? <span className="sr-only">{` (sorted ${direction}ending)`}</span> : null}
      </Link>
    );
  };
  // Each cell names its column for screen readers: the headings are not a real table header.
  const cell = (label: string, value: string | number, className = '') => (
    <span className={className}>
      <span className="sr-only">{label}: </span>
      {value}
    </span>
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
            {cell('Name', lead.name, 'font-medium')}
            {cell('Area', lead.area ?? '—')}
            {cell('Phone', lead.phone ?? '—')}
            {cell('Reviews', lead.reviewCount ?? '—')}
            {cell('Score', lead.score ?? '—', 'font-semibold')}
            {cell('Tier', lead.tier ?? '—', lead.tier === null ? '' : TIER_COLOURS[lead.tier])}
            {cell('Status', lead.status === 'FAILED' ? 'FAILED — open to retry' : lead.status)}
          </summary>
          <LeadEvidence lead={lead} />
          {lead.status === 'FAILED' ? (
            <form
              action={retryLead.bind(null, campaignId, lead.id)}
              className="bg-slate-50 px-4 pb-3"
            >
              <button
                type="submit"
                aria-label={`Retry ${lead.name}`}
                className="rounded border px-3 py-1 text-sm hover:bg-slate-100"
              >
                Retry from the failed step
              </button>
            </form>
          ) : null}
        </details>
      ))}
    </div>
  );
}
