/**
 * The campaign page's rules, kept pure so they are unit-tested: what a refused filter says, when a
 * retry counts as refused, and when the page keeps refreshing.
 *
 * Serves: FR-30 (lead table), FR-32 (retry), US-14 ("watch it progress"); issue #16.
 * Used by: apps/web/app/campaigns/[id]/*, apps/web/lib/lead-table.spec.ts.
 */
import type { CampaignSummary, LeadPage } from '@voxflow/shared';
import { ApiError, ApiRefusal } from './api';

// Statuses in which discovery or the reviews step can still add or change leads.
const CAMPAIGN_RUNNING = new Set<CampaignSummary['status']>(['DISCOVERING', 'ENRICHING']);
// Lead statuses the worker still moves on, e.g. a lead the founder just retried in a SCORING campaign.
const LEAD_PENDING = new Set(['DISCOVERED', 'ENRICHED']);

/**
 * Reads the messages of a 400 from the lead table API.
 * @param body - The API's JSON body.
 * @returns One line per message, e.g. "minScore: minScore must not be above maxScore"; a general
 * line when the body names no field.
 */
export function refusalMessages(body: unknown): string[] {
  const refusal = ApiRefusal.safeParse(body).data?.errors ?? [];
  const messages = refusal.flatMap(({ field, messages: list }) =>
    list.map((m) => `${field}: ${m}`),
  );
  return messages.length > 0 ? messages : ['These filters are not valid.'];
}

/**
 * Checks the API's answer to a retry.
 *
 * Does not treat 409 as a failure: the lead was retried already or is no longer FAILED, and the
 * re-rendered page shows its status.
 * @param status - The HTTP status of `POST /leads/:id/retry`.
 * @param body - Its parsed body.
 * @throws ApiError for any other error status (404, 400, 500), so the page shows it.
 */
export function checkRetry(status: number, body: unknown): void {
  if (status >= 400 && status !== 409) throw new ApiError(status, body);
}

/**
 * Tells whether the campaign page should keep refreshing itself.
 * @param status - The campaign's status.
 * @param leads - The page's leads, or the messages of refused filters.
 * @returns True while the campaign is discovering or enriching, or while a lead on this page is
 * still waiting for the worker.
 */
export function shouldRefresh(
  status: CampaignSummary['status'],
  leads: LeadPage | string[],
): boolean {
  if (CAMPAIGN_RUNNING.has(status)) return true;
  return !Array.isArray(leads) && leads.leads.some((lead) => LEAD_PENDING.has(lead.status));
}
