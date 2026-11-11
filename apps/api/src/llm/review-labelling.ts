/**
 * The review-labelling task: one LLM call per lead labels its unlabelled reviews (up to the 30
 * newest) with the niche's review labels. Builds the prompts, the answer schema and the mapping
 * from the answer back to reviews.
 *
 * Reviews go out under short ids (`r1`, `r2`, …): fewer tokens, no database ids in the prompt, and
 * the schema can list them, so the model cannot answer for a review it was not sent.
 * Changing the prompt file changes the fake adapter's fixture hashes: record the demo answers again
 * (`pnpm llm:record`, added with #13's demo fixtures).
 * The label meanings in the prompt are the dental-clinic niche's; a niche with other labels needs
 * its own meanings there.
 *
 * Serves: FR-13 (label reviews into signal types, JSON validated by Zod), ADR-0006; issue #13.
 * Used by: apps/api/src/pipeline/label-reviews.step.ts, apps/api/src/llm/review-labelling.spec.ts.
 */
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';

// From src/llm or dist/llm, two levels up is apps/api; the prompt is not copied into dist.
const PROMPT_FILE = resolve(import.meta.dirname, '../../src/agents/prompts/review-labelling.md');

// 30 reviews at about 20 tokens of JSON each, with room to spare; it also caps the worst case.
const MAX_TOKENS = 2_000;

/** A stored review to label. */
export interface ReviewToLabel {
  /** `Review.id`. */
  id: string;
  text: string;
  /** Stars from 1 to 5, or null when unknown. */
  rating: number | null;
}

/** The model's answer, once it passed the schema. */
export interface LabellingAnswer {
  reviews: { id: string; labels: string[] }[];
}

/** Everything one labelling call needs, and how to read its answer. */
export interface LabellingTask {
  system: string;
  user: string;
  schema: z.ZodType<LabellingAnswer>;
  maxTokens: number;
  /**
   * Maps a valid answer back to stored reviews.
   * @param answer - The parsed answer.
   * @returns One row per review: its `Review.id` and its labels, each label once.
   */
  labelsByReview(answer: LabellingAnswer): { reviewId: string; labels: string[] }[];
}

let promptTemplate: string | undefined;

/**
 * Builds the labelling call for one lead's reviews.
 *
 * Does not call the model or read the database: the step does both.
 * @param reviews - The reviews to label; at least one, at most the 30 newest.
 * @param labels - The niche's `reviewLabels`; at least one.
 * @returns The prompts, the schema and the answer mapping.
 * @throws Error when `reviews` or `labels` is empty; ENOENT when the prompt file is missing.
 */
export async function buildLabellingTask(
  reviews: readonly ReviewToLabel[],
  labels: readonly string[],
): Promise<LabellingTask> {
  const [firstLabel, ...otherLabels] = labels;
  if (reviews.length === 0 || firstLabel === undefined) {
    throw new Error('Labelling needs at least one review and one label');
  }
  promptTemplate ??= await readFile(PROMPT_FILE, 'utf8');
  const shortIds = reviews.map((_, index) => `r${String(index + 1)}`);
  const [firstId = 'r1', ...otherIds] = shortIds;

  const schema = z
    .object({
      reviews: z.array(
        z.object({
          id: z.enum([firstId, ...otherIds]),
          labels: z.array(z.enum([firstLabel, ...otherLabels])).min(1),
        }),
      ),
    })
    .superRefine((answer, context) => {
      // The JSON schema cannot say "each id exactly once", so it is checked here; the gate sends
      // this message back to the model on its one retry.
      const seen = answer.reviews.map((review) => review.id);
      const missing = shortIds.filter((id) => !seen.includes(id));
      const repeated = seen.filter((id, index) => seen.indexOf(id) !== index);
      if (missing.length > 0 || repeated.length > 0) {
        context.addIssue({
          code: 'custom',
          path: ['reviews'],
          message: `Answer every review exactly once. Missing: ${missing.join(', ') || 'none'}. Repeated: ${repeated.join(', ') || 'none'}.`,
        });
      }
    });

  return {
    system: promptTemplate.replace('{{labels}}', labels.join(', ')).trim(),
    user: JSON.stringify({
      reviews: reviews.map((review, index) => ({
        id: shortIds[index],
        stars: review.rating,
        text: review.text,
      })),
    }),
    schema,
    maxTokens: MAX_TOKENS,
    labelsByReview: (answer) =>
      answer.reviews.map(({ id, labels: given }) => {
        const review = reviews[shortIds.indexOf(id)];
        // The schema allows only ids from shortIds, so a miss means the schema is broken.
        if (review === undefined) throw new Error(`Labelling answer names unknown review ${id}`);
        return { reviewId: review.id, labels: [...new Set(given)] };
      }),
  };
}
