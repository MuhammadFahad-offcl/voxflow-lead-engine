/**
 * `/campaigns/new`: the new-campaign form, with the niches read from the API.
 *
 * Serves: FR-1, FR-30 (new campaign page); issue #16.
 * Used by: Next.js App Router, which serves this file at `/campaigns/new`.
 */
import { NicheSummary } from '@voxflow/shared';
import { connection } from 'next/server';
import { z } from 'zod';
import { apiGet } from '../../../lib/api';
import { NewCampaignForm } from './new-campaign-form';

/**
 * Renders the form, or says why it cannot.
 *
 * Does not cache: niches are read on every request, so a new niche version shows at once.
 * @returns The page.
 * @throws ApiError when the API is down; ZodError for an answer of the wrong shape. Next.js shows
 * app/error.tsx.
 */
export default async function NewCampaignPage() {
  await connection();
  const niches = await apiGet('/niches', z.array(NicheSummary));
  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <h1 className="mb-6 text-2xl font-semibold">New campaign</h1>
      {niches.length === 0 ? (
        <p>
          No niche is set up yet: run <code>pnpm db:seed</code>.
        </p>
      ) : (
        <NewCampaignForm niches={niches} />
      )}
    </main>
  );
}
