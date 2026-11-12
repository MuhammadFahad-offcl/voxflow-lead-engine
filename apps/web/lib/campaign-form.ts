/**
 * The new-campaign form's rules, kept pure so they are unit-tested: reading the areas field,
 * toggling a quick pick, the live grid size, and turning the API's or Zod's complaints into
 * messages per field.
 *
 * Serves: FR-1 (new campaign: niche, city, areas), FR-2 (grid = search terms × areas); issue #16.
 * Used by: apps/web/app/campaigns/new/*, apps/web/lib/campaign-form.spec.ts.
 */
import { z } from 'zod';
import { ApiRefusal } from './api';

/** Messages per form field; `form` holds the ones that belong to no field. */
export type FieldErrors = Partial<Record<'nicheSlug' | 'city' | 'areas' | 'form', string[]>>;

/**
 * Reads the areas field: one area per comma or line, trimmed, blanks dropped.
 * @param text - What the founder typed.
 * @returns The areas, in order; duplicates are kept so the schema can say "only once".
 */
export function parseAreas(text: string): string[] {
  return text
    .split(/[,\n]/)
    .map((area) => area.trim())
    .filter((area) => area !== '');
}

/**
 * Adds a quick-pick area to the field, or removes it when it is already there.
 * @param text - The areas field.
 * @param area - The quick pick, e.g. "Gulberg".
 * @returns The new field text, comma-separated.
 */
export function toggleArea(text: string, area: string): string {
  const areas = parseAreas(text);
  const has = areas.some((item) => item.toLowerCase() === area.toLowerCase());
  const next = has
    ? areas.filter((item) => item.toLowerCase() !== area.toLowerCase())
    : [...areas, area];
  return next.join(', ');
}

/**
 * The number of searches a campaign will run (FR-2).
 * @param searchTermCount - The niche's search terms.
 * @param areas - The areas field's areas.
 * @returns Terms × areas.
 */
export function gridSize(searchTermCount: number, areas: readonly string[]): number {
  return searchTermCount * areas.length;
}

/**
 * Turns a 400 from `POST /campaigns`, or the ZodError of a check before sending, into messages.
 * @param body - The API's JSON body, or a ZodError.
 * @returns Messages per field, each once; an area's own message (e.g. "areas.2") goes under
 * `areas`.
 */
export function toFieldErrors(body: unknown): FieldErrors {
  const issues =
    body instanceof z.ZodError
      ? body.issues.map((issue) => ({ field: issue.path.join('.'), messages: [issue.message] }))
      : (ApiRefusal.safeParse(body).data?.errors ?? []);
  const errors: FieldErrors = {};
  for (const { field, messages } of issues) {
    const name = field.split('.')[0];
    const key = name === 'nicheSlug' || name === 'city' || name === 'areas' ? name : 'form';
    // Two empty areas give the same message twice; show it once.
    errors[key] = [...new Set([...(errors[key] ?? []), ...messages])];
  }
  return errors;
}

/** What a submit of the form came to: the new campaign's id, or messages to show. */
export type SubmitResult = { id: string } | { errors: FieldErrors };

const Created = z.object({ id: z.string().min(1) });

/**
 * Reads the API's answer to `POST /campaigns`.
 *
 * Never tells the founder to simply try again when the campaign may already exist: a second
 * campaign would run (and pay for) the same searches twice.
 * @param status - The HTTP status; 0 when the API did not answer.
 * @param body - The parsed body.
 * @returns The new id on 201; otherwise the messages.
 */
export function submitResult(status: number, body: unknown): SubmitResult {
  if (status === 201) {
    const created = Created.safeParse(body);
    return created.success
      ? { id: created.data.id }
      : {
          errors: {
            form: [
              'The campaign was created, but its answer was unreadable: open it from the campaigns list.',
            ],
          },
        };
  }
  if (status === 0) {
    return {
      errors: {
        form: [
          'The API did not answer. Check the campaigns list before trying again: the campaign may already exist.',
        ],
      },
    };
  }
  if (status === 404) return { errors: { nicheSlug: ['That niche no longer exists'] } };
  const errors = status === 400 ? toFieldErrors(body) : {};
  return Object.keys(errors).length > 0
    ? { errors }
    : { errors: { form: [`The API refused the campaign (${String(status)}).`] } };
}
