'use server';
/**
 * The new-campaign form's Server Action: checks the fields with the shared schema, sends
 * `POST /campaigns` from the server, and opens the new campaign. The browser never calls the API.
 *
 * Serves: FR-1 (create a campaign), FR-2; issue #16.
 * Used by: apps/web/app/campaigns/new/new-campaign-form.tsx.
 */
import { CampaignSummary, CreateCampaignInput } from '@voxflow/shared';
import { redirect } from 'next/navigation';
import { parseAreas, toFieldErrors, type FieldErrors } from '../../../lib/campaign-form';
import { apiPost } from '../../../lib/api';

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
 * @throws Next.js's redirect signal to `/campaigns/<id>` once it is created.
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

  let created: CampaignSummary;
  try {
    const { status, body } = await apiPost('/campaigns', input.data);
    if (status === 400) return { errors: toFieldErrors(body), values };
    if (status === 404) return { errors: { nicheSlug: ['That niche no longer exists'] }, values };
    if (status !== 201) return { errors: { form: [`The API answered ${String(status)}`] }, values };
    created = CampaignSummary.parse(body);
  } catch {
    return { errors: { form: ['The API is not reachable: is `pnpm dev` running?'] }, values };
  }
  // Outside the try: redirect() works by throwing, and the catch above would swallow it.
  redirect(`/campaigns/${created.id}`);
}
