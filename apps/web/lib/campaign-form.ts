/**
 * The new-campaign form's rules, kept pure so they are unit-tested: reading the areas field,
 * toggling a quick pick, the live grid size, and turning the API's or Zod's complaints into
 * messages per field.
 *
 * Serves: FR-1 (new campaign: niche, city, areas), FR-2 (grid = search terms × areas); issue #16.
 * Used by: apps/web/app/campaigns/new/*, apps/web/lib/campaign-form.spec.ts.
 */
import { z } from 'zod';

/** Messages per form field; `form` holds the ones that belong to no field. */
export type FieldErrors = Partial<Record<'nicheSlug' | 'city' | 'areas' | 'form', string[]>>;

/**
 * Reads the areas field: one area per comma or line, trimmed, blanks dropped.
 * @param text - What the founder typed.
 * @returns The areas, in order; duplicates are kept so the API can say "only once".
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

// The API's 400 body: one entry per field, with its messages.
const ApiValidation = z.object({
  errors: z.array(z.object({ field: z.string(), messages: z.array(z.string()) })),
});

/**
 * Turns a 400 from `POST /campaigns`, or a Zod error raised before sending, into form messages.
 * @param body - The API's JSON body, or the issues of a local Zod check.
 * @returns Messages per field; an area's own message (e.g. "areas.2") goes under `areas`.
 */
export function toFieldErrors(body: unknown): FieldErrors {
  const issues =
    body instanceof z.ZodError
      ? body.issues.map((issue) => ({ field: issue.path.join('.'), messages: [issue.message] }))
      : (ApiValidation.safeParse(body).data?.errors ?? []);
  const errors: FieldErrors = {};
  for (const { field, messages } of issues) {
    const name = field.split('.')[0];
    const key = name === 'nicheSlug' || name === 'city' || name === 'areas' ? name : 'form';
    errors[key] = [...(errors[key] ?? []), ...messages];
  }
  return errors;
}
