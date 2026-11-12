/**
 * Unit tests of the new-campaign form's rules: the areas field, quick picks, the grid size, and
 * messages per field from the API or Zod.
 *
 * Serves: FR-1, FR-2; issue #16 ("the form rejects an empty niche, city or area list with a clear
 * message").
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { CreateCampaignInput } from '@voxflow/shared';
import { gridSize, parseAreas, submitResult, toFieldErrors, toggleArea } from './campaign-form';

// Proves the areas field reads commas and lines, and quick picks add and remove an area.
describe('parseAreas and toggleArea', () => {
  it('splits on commas and lines, trims, and drops blanks', () => {
    expect(parseAreas(' DHA, Gulberg\nModel Town,, ')).toEqual(['DHA', 'Gulberg', 'Model Town']);
  });

  it('adds a quick pick, and removes it on a second click whatever the case', () => {
    expect(toggleArea('DHA', 'Gulberg')).toBe('DHA, Gulberg');
    expect(toggleArea('DHA, gulberg', 'Gulberg')).toBe('DHA');
  });
});

// Proves FR-2's grid: one search per term per area.
describe('gridSize', () => {
  it('multiplies the niche search terms by the areas', () => {
    expect(gridSize(4, ['DHA', 'Gulberg'])).toBe(8);
    expect(gridSize(4, [])).toBe(0);
  });
});

// Proves every complaint lands under the field it is about, from the API or from Zod.
describe('toFieldErrors', () => {
  it('reads the API 400 body, putting an area’s own message under areas', () => {
    const body = {
      errors: [
        { field: 'city', messages: ['city is required'] },
        { field: 'areas.1', messages: ['an area cannot be empty'] },
        { field: '(body)', messages: ['Unrecognized key'] },
      ],
    };

    expect(toFieldErrors(body)).toEqual({
      city: ['city is required'],
      areas: ['an area cannot be empty'],
      form: ['Unrecognized key'],
    });
  });

  it('reads the shared schema’s messages for an empty niche, city and area list', () => {
    const result = CreateCampaignInput.safeParse({ nicheSlug: '', city: ' ', areas: [] });

    expect(toFieldErrors(result.error)).toEqual({
      nicheSlug: ['nicheSlug is required'],
      city: ['city is required'],
      areas: ['give at least one area'],
    });
  });

  it('returns nothing for a body that is not a validation answer', () => {
    expect(toFieldErrors({ message: 'Internal error' })).toEqual({});
  });
});

// Proves a submit never invites a duplicate campaign, and every refusal shows a message.
describe('submitResult', () => {
  it('opens the new campaign on 201', () => {
    expect(submitResult(201, { id: 'cmfictional0001' })).toEqual({ id: 'cmfictional0001' });
  });

  it('says it was created, not "try again", when a 201 answer is unreadable', () => {
    expect(submitResult(201, { nope: true })).toEqual({
      errors: { form: [expect.stringContaining('was created')] },
    });
  });

  it('warns that the campaign may exist when the API did not answer', () => {
    expect(submitResult(0, null)).toEqual({
      errors: { form: [expect.stringContaining('may already exist')] },
    });
  });

  it('shows field messages for a 400, and a form message when the 400 names no field', () => {
    expect(
      submitResult(400, { errors: [{ field: 'city', messages: ['city is required'] }] }),
    ).toEqual({
      errors: { city: ['city is required'] },
    });
    expect(submitResult(400, { message: 'Bad Request' })).toEqual({
      errors: { form: ['The API refused the campaign (400).'] },
    });
  });

  it('puts a 404 under the niche, and any other status in a form message', () => {
    expect(submitResult(404, null)).toEqual({
      errors: { nicheSlug: ['That niche no longer exists'] },
    });
    expect(submitResult(503, null)).toEqual({
      errors: { form: ['The API refused the campaign (503).'] },
    });
  });

  it('shows a repeated message once', () => {
    const body = {
      errors: [
        { field: 'areas.1', messages: ['an area cannot be empty'] },
        { field: 'areas.3', messages: ['an area cannot be empty'] },
      ],
    };

    expect(toFieldErrors(body)).toEqual({ areas: ['an area cannot be empty'] });
  });
});
