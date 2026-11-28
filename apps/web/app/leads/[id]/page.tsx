/**
 * `/leads/[id]`: one lead's detail page, read from `GET /leads/:id` on the server.
 *
 * Serves: FR-30 (lead detail), FR-17, US-5; issue #24.
 * Used by: Next.js App Router, which serves this file at `/leads/<id>`; linked from the lead table.
 */
import { LeadDetail } from '@voxflow/shared';
import { notFound } from 'next/navigation';
import { connection } from 'next/server';
import { ApiError, apiGet } from '../../../lib/api';
import { LeadDetailView } from './lead-detail';

/**
 * Reads the lead, or shows Next.js's 404 page for an unknown or malformed id.
 * @param id - Lead id from the URL.
 * @returns The lead.
 * @throws ApiError for any other API failure (Next.js shows its error page).
 */
async function readLead(id: string): Promise<LeadDetail> {
  try {
    return await apiGet(`/leads/${encodeURIComponent(id)}`, LeadDetail);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 400)) notFound();
    throw error;
  }
}

/**
 * Renders the lead page.
 * @param props - Next.js page props.
 * @param props.params - The route's `id`.
 * @returns The page.
 * @throws ApiError when the API is down; ZodError for an answer of the wrong shape. Next.js shows
 * app/error.tsx.
 */
export default async function LeadPage({ params }: Readonly<{ params: Promise<{ id: string }> }>) {
  await connection();
  return <LeadDetailView lead={await readLead((await params).id)} />;
}
