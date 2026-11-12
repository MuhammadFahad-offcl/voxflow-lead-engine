'use server';
/**
 * The new-campaign form's Server Action: checks the fields with the shared schema, sends
 * `POST /campaigns` from the server, and opens the new campaign. The browser never calls the API.
 *
 * Serves: FR-1 (create a campaign), FR-2; issue #16.
 * Used by: apps/web/app/campaigns/new/new-campaign-form.tsx.
 */
import { CreateCampaignInput } from '@voxflow/shared';
import { redirect } from 'next/navigation';
import { ApiError, apiPost } from '../../../lib/api';
import {
  parseAreas,
  submitResult,
  toFieldErrors,
  type FieldErrors,
} from '../../../lib/campaign-form';

/** What the form shows after a failed submit: the messages, and what was typed. */
export interface CreateCampaignState {
  errors: FieldErrors;
  values: { nicheSlug: string; city: string; areas: string };
}

const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value : '';
};

/**
 * Creates a campaign from the form and opens it.
 * @param _previous - The form's previous state (React's `useActionState` passes it; unused).
 * @param form - The submitted fields: `nicheSlug`, `city`, `areas`.
 * @returns The messages to show when the campaign was not created.
 * @throws Next.js's redirect signal to `/campaigns/<id>` once it is created; any error that is not
 * an ApiError (a bug), which Next.js shows as its error page.
 */
export async function createCampaign(
  _previous: CreateCampaignState,
  form: FormData,
): Promise<CreateCampaignState> {
  const values = {
    nicheSlug: text(form, 'nicheSlug'),
    city: text(form, 'city'),
    areas: text(form, 'areas'),
  };
  const input = CreateCampaignInput.safeParse({
    nicheSlug: values.nicheSlug,
    city: values.city,
    areas: parseAreas(values.areas),
  });
  if (!input.success) return { errors: toFieldErrors(input.error), values };

  let answer: { status: number; body: unknown };
  try {
    answer = await apiPost('/campaigns', input.data);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    // Status 0 (no answer) or an unreadable error page: submitResult words both safely.
    answer = { status: error.status, body: error.body };
  }
  const result = submitResult(answer.status, answer.body);
  if ('errors' in result) return { errors: result.errors, values };
  // Outside any try: redirect() works by throwing.
  redirect(`/campaigns/${result.id}`);
}
