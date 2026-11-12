/**
 * `/campaigns`: every campaign, newest first, with its status and discovery counts.
 *
 * Serves: FR-30 (campaigns page), FR-3, NFR-13 (Asia/Karachi times); issue #16.
 * Used by: Next.js App Router, which serves this file at `/campaigns`.
 */
import { CampaignSummary } from '@voxflow/shared';
import Link from 'next/link';
import { connection } from 'next/server';
import { z } from 'zod';
import { apiGet } from '../../lib/api';
import { karachiTime, percent } from '../../lib/format';
import { StatusBadge } from './status-badge';

/**
 * Renders the campaigns table.
 *
 * Does not cache: statuses change while a campaign runs.
 * @returns The page.
 */
export default async function CampaignsPage() {
  await connection();
  const campaigns = await apiGet('/campaigns', z.array(CampaignSummary));
  const cell = 'px-3 py-2';
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Campaigns</h1>
        <Link href="/campaigns/new" className="rounded bg-slate-900 px-4 py-2 text-white">
          New campaign
        </Link>
      </div>
      {campaigns.length === 0 ? (
        <p>No campaigns yet.</p>
      ) : (
        <table className="w-full border-collapse bg-white text-sm">
          <thead className="border-b text-left text-slate-600">
            <tr>
              {[
                'Created',
                'Campaign',
                'Status',
                'Searches',
                'Found',
                'Duplicates',
                'Filtered',
                'Qualified',
              ].map((heading) => (
                <th key={heading} className={`${cell} font-medium`}>
                  {heading}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <tr key={campaign.id} className="border-b last:border-0 hover:bg-slate-50">
                <td className={cell}>{karachiTime(campaign.createdAt)}</td>
                <td className={cell}>
                  <Link href={`/campaigns/${campaign.id}`} className="font-medium underline">
                    {campaign.nicheSlug} · {campaign.city} · {campaign.areas.join(', ')}
                  </Link>
                </td>
                <td className={cell}>
                  <StatusBadge status={campaign.status} />
                  {campaign.pauseReason === null ? null : (
                    <p className="mt-1 max-w-xs text-xs text-amber-800">{campaign.pauseReason}</p>
                  )}
                </td>
                <td className={cell}>{campaign.grid.searches}</td>
                <td className={cell}>{campaign.foundCount}</td>
                <td className={cell}>{percent(campaign.duplicateRate)}</td>
                <td className={cell}>{campaign.filteredCount}</td>
                <td className={cell}>{campaign.qualifiedCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
