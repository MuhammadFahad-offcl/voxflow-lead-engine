/**
 * A campaign status as a coloured badge: running statuses blue, waiting amber, done green,
 * failed red.
 *
 * Serves: FR-30 (campaigns list: status badge), FR-3; issue #16.
 * Used by: apps/web/app/campaigns/page.tsx, apps/web/app/campaigns/[id]/page.tsx.
 */
import type { CampaignSummary } from '@voxflow/shared';

const COLOURS: Record<CampaignSummary['status'], string> = {
  DISCOVERING: 'bg-blue-100 text-blue-800',
  ENRICHING: 'bg-blue-100 text-blue-800',
  SCORING: 'bg-indigo-100 text-indigo-800',
  SCRIPTING: 'bg-indigo-100 text-indigo-800',
  AWAITING_APPROVAL: 'bg-amber-100 text-amber-800',
  CALLING: 'bg-blue-100 text-blue-800',
  COMPLETED: 'bg-green-100 text-green-800',
  PAUSED: 'bg-amber-100 text-amber-800',
  FAILED: 'bg-red-100 text-red-800',
};

/**
 * Renders the badge.
 * @param props - The status.
 * @param props.status - A campaign status, e.g. "ENRICHING".
 * @returns The badge, e.g. "Enriching".
 */
export function StatusBadge({ status }: Readonly<{ status: CampaignSummary['status'] }>) {
  const label = status.charAt(0) + status.slice(1).toLowerCase().replaceAll('_', ' ');
  return (
    <span className={`rounded px-2 py-0.5 text-xs font-medium ${COLOURS[status]}`}>{label}</span>
  );
}
