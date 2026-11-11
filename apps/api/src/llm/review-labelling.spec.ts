/**
 * Unit tests of the review-labelling task: the prompts it builds, the answer schema that only
 * accepts the niche's labels and the reviews it sent, and how answers map back to reviews.
 *
 * Serves: FR-13 (labels as Zod-validated JSON, invalid output rejected), ADR-0006; issue #13.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import { describe, expect, it } from '@jest/globals';
import { buildLabellingTask } from './review-labelling.js';

const LABELS = ['PHONE_UNANSWERED', 'BOOKING_OR_WAIT', 'POSITIVE', 'OTHER'];
const reviews = [
  { id: 'cuid-review-a', text: 'Nobody picks up the phone.', rating: 2 },
  { id: 'cuid-review-b', text: 'Doctor sahib bohat achay hain.', rating: 5 },
  { id: 'cuid-review-c', text: 'Waited two hours.', rating: null },
];

// Proves the prompts name the niche's labels and send short ids, stars and text, nothing else.
describe('buildLabellingTask prompts', () => {
  it('puts the niche labels in the system prompt', async () => {
    const task = await buildLabellingTask(reviews, LABELS);

    expect(task.system).toContain('using only these labels: PHONE_UNANSWERED, BOOKING_OR_WAIT');
    expect(task.system).not.toContain('{{');
  });

  it('sends each review as a short id with its stars and text, never the database id', async () => {
    const task = await buildLabellingTask(reviews, LABELS);

    expect(JSON.parse(task.user)).toEqual({
      reviews: [
        { id: 'r1', stars: 2, text: 'Nobody picks up the phone.' },
        { id: 'r2', stars: 5, text: 'Doctor sahib bohat achay hain.' },
        { id: 'r3', stars: null, text: 'Waited two hours.' },
      ],
    });
    expect(task.user).not.toContain('cuid-review');
  });
});

// Proves the schema rejects anything but one answer per sent review, with the niche's labels.
describe('buildLabellingTask schema', () => {
  const answer = (items: { id: string; labels: string[] }[]) => ({ reviews: items });
  const all = [
    { id: 'r1', labels: ['PHONE_UNANSWERED'] },
    { id: 'r2', labels: ['POSITIVE'] },
    { id: 'r3', labels: ['BOOKING_OR_WAIT'] },
  ];

  it('accepts one answer per review, in any order', async () => {
    const { schema } = await buildLabellingTask(reviews, LABELS);

    expect(schema.safeParse(answer([...all].reverse())).success).toBe(true);
  });

  it.each([
    ['an unknown review id', [...all, { id: 'r9', labels: ['OTHER'] }]],
    ['a missing review', all.slice(0, 2)],
    ['a review answered twice', [...all, { id: 'r1', labels: ['OTHER'] }]],
    ['a label the niche does not have', [{ id: 'r1', labels: ['PRICE'] }, ...all.slice(1)]],
    ['a review with no label', [{ id: 'r1', labels: [] }, ...all.slice(1)]],
  ])('rejects %s', async (_what, items) => {
    const { schema } = await buildLabellingTask(reviews, LABELS);

    expect(schema.safeParse(answer(items)).success).toBe(false);
  });

  it('can be sent to the API as a JSON output format', async () => {
    const { schema } = await buildLabellingTask(reviews, LABELS);

    expect(() => zodOutputFormat(schema)).not.toThrow();
  });
});

// Proves answers go back to the right database review, each label once.
describe('buildLabellingTask labelsByReview', () => {
  it('maps short ids back to review ids and drops repeated labels', async () => {
    const task = await buildLabellingTask(reviews, LABELS);

    const rows = task.labelsByReview({
      reviews: [
        { id: 'r3', labels: ['BOOKING_OR_WAIT', 'BOOKING_OR_WAIT'] },
        { id: 'r1', labels: ['PHONE_UNANSWERED'] },
        { id: 'r2', labels: ['POSITIVE', 'OTHER'] },
      ],
    });

    expect(rows).toEqual([
      { reviewId: 'cuid-review-c', labels: ['BOOKING_OR_WAIT'] },
      { reviewId: 'cuid-review-a', labels: ['PHONE_UNANSWERED'] },
      { reviewId: 'cuid-review-b', labels: ['POSITIVE', 'OTHER'] },
    ]);
  });
});
