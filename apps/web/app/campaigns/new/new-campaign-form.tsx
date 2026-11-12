'use client';
/**
 * The new-campaign form: niche, city, areas with the niche's default areas as quick picks, and
 * the grid size as you type. Submits through a Server Action and shows its messages per field.
 *
 * Serves: FR-1, FR-2 (grid size shown live); issue #16 ("rejects an empty niche, city or area list
 * with a clear message").
 * Used by: apps/web/app/campaigns/new/page.tsx.
 */
import type { NicheSummary } from '@voxflow/shared';
import { useActionState, useState } from 'react';
import { gridSize, parseAreas, toggleArea } from '../../../lib/campaign-form';
import { createCampaign, type CreateCampaignState } from './actions';

/**
 * Lists a field's messages under it.
 * @param props - The messages.
 * @param props.messages - The field's messages, if any.
 * @returns The list, or nothing.
 */
function FieldErrorList({ messages }: Readonly<{ messages: string[] | undefined }>) {
  if (messages === undefined || messages.length === 0) return null;
  return (
    <ul role="alert" className="mt-1 text-sm text-red-700">
      {messages.map((message) => (
        <li key={message}>{message}</li>
      ))}
    </ul>
  );
}

/**
 * Renders the form.
 * @param props - The niches a campaign can use.
 * @param props.niches - From `GET /niches`, newest version each.
 * @returns The form.
 */
export function NewCampaignForm({ niches }: Readonly<{ niches: NicheSummary[] }>) {
  const initial: CreateCampaignState = {
    errors: {},
    values: { nicheSlug: niches[0]?.slug ?? '', city: 'Lahore', areas: '' },
  };
  const [state, submit, pending] = useActionState(createCampaign, initial);
  const [nicheSlug, setNicheSlug] = useState(state.values.nicheSlug);
  const [areas, setAreas] = useState(state.values.areas);
  const niche = niches.find((item) => item.slug === nicheSlug);
  const searches = gridSize(niche?.searchTermCount ?? 0, parseAreas(areas));
  const picks = new Set(parseAreas(areas).map((area) => area.toLowerCase()));
  const input = 'mt-1 w-full rounded border border-slate-300 bg-white px-3 py-2';

  return (
    <form action={submit} className="max-w-xl space-y-5">
      <label className="block">
        <span className="font-medium">Niche</span>
        {/* Uncontrolled: React resets a form after its action, and a controlled select would fall
            back to its first option while this component's state kept the founder's choice. */}
        <select
          name="nicheSlug"
          defaultValue={state.values.nicheSlug}
          aria-invalid={state.errors.nicheSlug !== undefined}
          onChange={(event) => {
            setNicheSlug(event.target.value);
          }}
          className={input}
        >
          {niches.map((item) => (
            <option key={item.slug} value={item.slug}>
              {item.name} (v{item.version})
            </option>
          ))}
        </select>
        <FieldErrorList messages={state.errors.nicheSlug} />
      </label>

      <label className="block">
        <span className="font-medium">City</span>
        <input
          name="city"
          defaultValue={state.values.city}
          aria-invalid={state.errors.city !== undefined}
          className={input}
        />
        <FieldErrorList messages={state.errors.city} />
      </label>

      <div>
        <label className="block">
          <span className="font-medium">Areas</span>
          <textarea
            name="areas"
            value={areas}
            onChange={(event) => {
              setAreas(event.target.value);
            }}
            rows={2}
            placeholder="DHA, Gulberg"
            aria-invalid={state.errors.areas !== undefined}
            className={input}
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2">
          {niche?.defaultAreas.map((area) => {
            const picked = picks.has(area.toLowerCase());
            return (
              <button
                key={area}
                type="button"
                aria-pressed={picked}
                onClick={() => {
                  setAreas((current) => toggleArea(current, area));
                }}
                className={`rounded-full border px-3 py-1 text-sm ${picked ? 'border-slate-900 bg-slate-900 text-white' : 'border-slate-300 hover:bg-slate-100'}`}
              >
                {area}
              </button>
            );
          })}
        </div>
        <FieldErrorList messages={state.errors.areas} />
      </div>

      <p className="text-sm text-slate-600">
        {niche?.searchTermCount ?? 0} search terms × {parseAreas(areas).length} areas ={' '}
        <strong>{searches} searches</strong>.
      </p>
      <FieldErrorList messages={state.errors.form} />

      <button
        type="submit"
        disabled={pending}
        className="rounded bg-slate-900 px-4 py-2 font-medium text-white disabled:opacity-50"
      >
        {pending ? 'Creating…' : 'Create campaign'}
      </button>
    </form>
  );
}
