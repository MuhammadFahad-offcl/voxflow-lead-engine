/**
 * Unit tests of the solution agent's answer rules: a retrieved service, the lead's own signals,
 * and at least one PAIN signal.
 *
 * Serves: FR-17; issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { checkSolutionPick } from './solution-validation.js';

const context = {
  retrievedSlugs: ['ai-voice-receptionist', 'missed-call-whatsapp-reply', 'patient-recall'],
  leadSignals: [
    { key: 'phone_unanswered_reviews', dimension: 'PAIN' },
    { key: 'mobile_number', dimension: 'REACHABILITY' },
    { key: 'many_reviews', dimension: 'FIT' },
  ],
};
const pick = (serviceSlug: string, signalIds: string[]) => ({
  serviceSlug,
  reason: 'Patients say nobody answers the phone.',
  signalIds,
});

// Proves each FR-17 rule accepts a valid pick and names exactly what is wrong with a bad one.
describe('checkSolutionPick', () => {
  it('accepts a retrieved service citing the lead’s own signals, one of them PAIN', () => {
    expect(
      checkSolutionPick(
        pick('ai-voice-receptionist', ['phone_unanswered_reviews', 'mobile_number']),
        context,
      ),
    ).toEqual({ ok: true });
  });

  it('rejects a service searchCatalog did not return, even a real catalog service', () => {
    expect(
      checkSolutionPick(pick('online-booking-page', ['phone_unanswered_reviews']), context),
    ).toEqual({
      ok: false,
      problems: [
        'serviceSlug "online-booking-page" is not one of the services searchCatalog returned: ai-voice-receptionist, missed-call-whatsapp-reply, patient-recall.',
      ],
    });
  });

  it('rejects a signal the lead does not have', () => {
    expect(
      checkSolutionPick(
        pick('ai-voice-receptionist', ['phone_unanswered_reviews', 'no_online_booking']),
        context,
      ),
    ).toEqual({
      ok: false,
      problems: [
        'signal "no_online_booking" is not one of this lead’s signals: phone_unanswered_reviews, mobile_number, many_reviews.',
      ],
    });
  });

  it('rejects a pick that cites no PAIN signal', () => {
    expect(checkSolutionPick(pick('patient-recall', ['many_reviews']), context)).toEqual({
      ok: false,
      problems: [
        'no PAIN signal is cited; cite at least one of: phone_unanswered_reviews. If none fits, answer noStrongSignal.',
      ],
    });
  });

  it('lists every problem at once, so one retry can fix them all', () => {
    const result = checkSolutionPick(pick('online-booking-page', ['invented_signal']), context);

    expect(result.ok).toBe(false);
    expect(result.ok ? [] : result.problems).toHaveLength(3);
  });

  it('rejects any pick when searchCatalog was never called', () => {
    const result = checkSolutionPick(pick('ai-voice-receptionist', ['phone_unanswered_reviews']), {
      ...context,
      retrievedSlugs: [],
    });

    expect(result).toEqual({
      ok: false,
      problems: ['searchCatalog was not called: call it before picking a service.'],
    });
  });
});
