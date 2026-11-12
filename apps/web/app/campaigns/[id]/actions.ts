'use server';
/**
 * The lead table's Server Action: the Retry button of a FAILED lead. It calls the API from the
 * server and re-renders the campaign page; the worker picks the lead up within a pass.
 *
 * Serves: FR-32 (a failed lead shows a retry button); issue #16.
 * Used by: apps/web/app/campaigns/[id]/lead-table.tsx.
 */
import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { apiPost } from '../../../lib/api';
import { checkRetry } from '../../../lib/lead-table';

// Both ids come from the page the button is on; checked again, because a Server Action is a POST
// endpoint anyone on this machine could call with anything.
const Id = z.string().regex(/^[a-z0-9]{1,64}$/);

/**
 * Puts a FAILED lead back in the queue from its failed step.
 *
 * Does not report a 409 (the lead was already retried or is no longer FAILED): the page re-renders
 * and shows its current status either way.
 * @param campaignId - The campaign whose page to re-render.
 * @param leadId - The FAILED lead.
 * @throws ZodError for an id that is not a cuid; ApiError when the API is down or answers any other
 * error (404, 500), which Next.js shows as app/error.tsx.
 */
export async function retryLead(campaignId: string, leadId: string): Promise<void> {
  const campaign = Id.parse(campaignId);
  // The route takes no body; an empty JSON object keeps the client's one way of posting.
  const { status, body } = await apiPost(`/leads/${Id.parse(leadId)}/retry`, {});
  checkRetry(status, body);
  revalidatePath(`/campaigns/${campaign}`);
}
