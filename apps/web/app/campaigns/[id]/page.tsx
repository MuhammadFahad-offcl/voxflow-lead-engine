/**
 * `/campaigns/[id]`: one campaign's status and counts. The lead table joins it in the next #16 PR.
 *
 * Serves: FR-30 (campaign page), FR-3, US-14 ("found, duplicate, filtered and qualified counts"),
 * NFR-13; issue #16.
 * Used by: Next.js App Router, which serves this file at `/campaigns/<id>`.
 */
import { CampaignSummary } from '@voxflow/shared';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ApiError, apiGet } from '../../../lib/api';
import { karachiTime, percent } from '../../../lib/format';
import { StatusBadge } from '../status-badge';

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
 * Renders the campaign's summary.
 * @param props - Next.js page props.
 * @param props.params - The route's `id`.
 * @returns The page.
 * @throws ApiError when the API is down; ZodError for an answer of the wrong shape. Next.js shows
 * app/error.tsx.
 */
export default async function CampaignPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  await connection();
  const campaign = await readCampaign((await params).id);
  const counts: [string, string | number][] = [
    ['Searches', campaign.grid.searches],
    ['Found', campaign.foundCount],
    ['Duplicates', `${String(campaign.duplicateCount)} (${percent(campaign.duplicateRate)})`],
    ['Filtered out', campaign.filteredCount],
    ['Qualified', campaign.qualifiedCount],
  ];
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
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
    </main>
  );
}
