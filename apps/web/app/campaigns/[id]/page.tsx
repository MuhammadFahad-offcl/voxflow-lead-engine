/**
 * `/campaigns/[id]`: one campaign's status and counts, then its lead table with filters, sort,
 * paging and CSV export. While work is in flight the page re-renders every 10 seconds, keeping
 * open rows and typed filters.
 *
 * Serves: FR-30 (campaign page, lead table), FR-3, FR-32 (retry), US-14 ("found, duplicate,
 * filtered and qualified counts"; filter, sort, export), NFR-13; issue #16.
 * Used by: Next.js App Router, which serves this file at `/campaigns/<id>`.
 */
import { CampaignSummary, LeadPage } from '@voxflow/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ApiError, apiGet } from '../../../lib/api';
import { karachiTime, percent } from '../../../lib/format';
import { readLeadQuery, toSearch, type LeadQuery } from '../../../lib/lead-query';
import { refusalMessages, shouldRefresh } from '../../../lib/lead-table';
import { StatusBadge } from '../status-badge';
import { AutoRefresh } from './auto-refresh';
import { LeadFilters } from './lead-filters';
import { LeadTable } from './lead-table';

/**
 * Reads the campaign, or shows Next.js's 404 page for an unknown id.
 * @param id - Campaign id from the URL.
 * @returns The campaign.
 * @throws ApiError for any other API failure (Next.js shows its error page).
 */
async function readCampaign(id: string): Promise<CampaignSummary> {
  try {
    return await apiGet(`/campaigns/${encodeURIComponent(id)}`, CampaignSummary);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
}

/**
 * Reads one page of the campaign's leads, or why the API refused the filters.
 *
 * A filter the founder typed (an area with `%`, a minimum above the maximum) or a hand-edited URL
 * is a 400, not a broken page: its messages are shown above the table.
 * @param campaignId - `Campaign.id`.
 * @param search - The table's query string.
 * @returns The page, or the API's messages, e.g. "minScore: minScore must not be above maxScore".
 * @throws ApiError for any other API failure (Next.js shows app/error.tsx).
 */
async function readLeads(campaignId: string, search: string): Promise<LeadPage | string[]> {
  try {
    return await apiGet(`/campaigns/${campaignId}/leads${search}`, LeadPage);
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 400) throw error;
    return refusalMessages(error.body);
  }
}

/**
 * Renders the campaign's summary and lead table.
 * @param props - Next.js page props.
 * @param props.params - The route's `id`.
 * @param props.searchParams - The lead table's filters, sort and page.
 * @returns The page.
 * @throws ApiError when the API is down; ZodError for an answer of the wrong shape. Next.js shows
 * app/error.tsx.
 */
export default async function CampaignPage({
  params,
  searchParams,
}: Readonly<{
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}>) {
  await connection();
  const campaign = await readCampaign((await params).id);
  const query = readLeadQuery(await searchParams);
  const leads = await readLeads(campaign.id, toSearch(query));
  const counts: [string, string | number][] = [
    ['Searches', campaign.grid.searches],
    ['Found', campaign.foundCount],
    ['Duplicates', `${String(campaign.duplicateCount)} (${percent(campaign.duplicateRate)})`],
    ['Filtered out', campaign.filteredCount],
    ['Qualified', campaign.qualifiedCount],
  ];
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <AutoRefresh active={shouldRefresh(campaign.status, leads)} />
      <h1 className="text-2xl font-semibold">
        {campaign.nicheSlug} · {campaign.city} · {campaign.areas.join(', ')}
      </h1>
      <p className="mt-2 flex items-center gap-3 text-sm text-slate-600">
        <StatusBadge status={campaign.status} />
        Created {karachiTime(campaign.createdAt)} (Pakistan time)
      </p>
      {campaign.pauseReason === null ? null : (
        <p className="mt-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {campaign.pauseReason}
        </p>
      )}
      <dl className="mt-6 grid grid-cols-5 gap-4">
        {counts.map(([label, value]) => (
          <div key={label} className="rounded border bg-white px-4 py-3">
            <dt className="text-xs text-slate-500">{label}</dt>
            <dd className="text-xl font-semibold">{value}</dd>
          </div>
        ))}
      </dl>
      <section className="mt-8 space-y-3">
        <h2 className="text-lg font-semibold">
          Leads{Array.isArray(leads) ? null : ` (${String(leads.total)})`}
        </h2>
        <LeadFilters campaignId={campaign.id} query={query} refused={Array.isArray(leads)} />
        {Array.isArray(leads) ? (
          <div role="alert" className="rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
            <ul>
              {leads.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
            <Link href={`/campaigns/${campaign.id}`} className="underline">
              Clear filters
            </Link>
          </div>
        ) : (
          <LeadPager campaignId={campaign.id} leads={leads} query={query} />
        )}
      </section>
    </main>
  );
}

/**
 * The lead table with its page links.
 * @param props - The page of leads and the URL state.
 * @param props.campaignId - The campaign, for the Retry action.
 * @param props.leads - One page of leads.
 * @param props.query - The current filters and sort.
 * @returns The table and the Previous / Next links.
 */
function LeadPager({
  campaignId,
  leads,
  query,
}: Readonly<{ campaignId: string; leads: LeadPage; query: LeadQuery }>) {
  const pages = Math.max(1, Math.ceil(leads.total / leads.pageSize));
  // Page 1 is the clean URL, without ?page=1.
  const previous = leads.page === 2 ? undefined : String(leads.page - 1);
  if (leads.leads.length === 0 && leads.total > 0) {
    // A page past the end, e.g. after the list shrank: offer the way back.
    return (
      <p className="py-6 text-slate-600">
        This page is past the last one.{' '}
        <Link href={toSearch(query, { page: undefined }) || '?'} className="underline">
          Back to page 1
        </Link>
      </p>
    );
  }
  return (
    <>
      <LeadTable campaignId={campaignId} page={leads} query={query} />
      <nav aria-label="Lead pages" className="flex items-center gap-4 text-sm">
        {leads.page > 1 ? (
          <Link href={toSearch(query, { page: previous }) || '?'} className="underline">
            Previous
          </Link>
        ) : null}
        <span>
          Page {leads.page} of {pages}
        </span>
        {leads.page < pages ? (
          <Link href={toSearch(query, { page: String(leads.page + 1) })} className="underline">
            Next
          </Link>
        ) : null}
      </nav>
    </>
  );
}
