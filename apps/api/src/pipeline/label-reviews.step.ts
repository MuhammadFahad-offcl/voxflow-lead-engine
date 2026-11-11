/**
 * The review-labelling part of the score step: one LLM call labels a lead's unlabelled reviews
 * (among the 30 newest) with its niche's labels, through the LLM gate, and stores the labels.
 * Not wired into a runner or graph yet: #15 does that.
 *
 * CAP_REACHED is only returned and logged, like the Perplexity step (#12): the cap is re-read from
 * the CostRecord rows on every call, so it clears by itself when the Karachi month turns or the cap
 * is raised. The pause and banner come with #15 and #16 (`GET /costs/status` reports the cap).
 *
 * Serves: FR-13, FR-33, NFR-4; issue #13.
 * Used by: apps/api/test/label-reviews.int.spec.ts only, until #15 calls it from the lead graph.
 */
import type { ReviewLabelRepository } from '../db/review-label.repository.js';
import {
  LlmOutputInvalidError,
  SpendCapReachedError,
  type LlmService,
} from '../llm/llm.service.js';
import { buildLabellingTask, type LabellingAnswer } from '../llm/review-labelling.js';
import { errorFields, type Logger } from '../logging/logger.js';
import { LlmError } from '../ports/llm.port.js';

// The label that earns no points in scoring (niche file: "no other label fits").
const NO_POINTS_LABEL = 'OTHER';

/** What the step needs from outside. */
export interface LabelReviewsDeps {
  reviews: ReviewLabelRepository;
  llm: Pick<LlmService, 'complete'>;
  logger: Logger;
}

/** How one run ended. CAP_REACHED carries the sentence for the dashboard banner (#16). */
export type LabelOutcome =
  | { status: 'LABELLED'; reviews: number }
  | { status: 'SKIPPED'; reason: 'FILTERED_OUT' | 'NOTHING_TO_LABEL' }
  | { status: 'CAP_REACHED'; reason: string }
  | { status: 'FAILED' };

/**
 * Labels one lead's unlabelled reviews and stores the labels.
 *
 * Reviews with no text (stars only) are labelled OTHER in code and never sent: there are no words
 * to be evidence. When every unlabelled review is blank, no call is made.
 * Safe to repeat: reviews that already have labels are not sent, so not paid for, again. The gate
 * records the cost of every attempt as it happens, so a failure after a paid call still counts.
 * A FAILED lead (the model failed, or answered badly twice) keeps its reviews unlabelled; #15 must
 * not retry it blindly, because a retry pays again.
 * Logs the lead id, counts and fixed words: never review text or an answer.
 * @param deps - Its dependencies.
 * @param leadId - `Lead.id` of the lead to label.
 * @returns What happened.
 * @throws Prisma errors, e.g. when there is no such lead; Error when the niche has no labels, no
 * OTHER label for blank reviews, or the task's model has no price (configuration bugs, not model
 * failures).
 */
export async function labelReviews(deps: LabelReviewsDeps, leadId: string): Promise<LabelOutcome> {
  const { reviews, llm, logger } = deps;
  const lead = await reviews.forLabelling(leadId);
  if (lead.status === 'FILTERED_OUT') return { status: 'SKIPPED', reason: 'FILTERED_OUT' };
  if (lead.unlabelled.length === 0) return { status: 'SKIPPED', reason: 'NOTHING_TO_LABEL' };

  // A star-only review has no words to be evidence of anything ("No evidence, no points"), so it
  // gets the no-points label in code and is never sent to the model.
  const blank = lead.unlabelled.filter((review) => review.text.trim() === '');
  const withText = lead.unlabelled.filter((review) => review.text.trim() !== '');
  if (blank.length > 0 && !lead.reviewLabels.includes(NO_POINTS_LABEL)) {
    throw new Error(`The niche has no ${NO_POINTS_LABEL} label for reviews without text`);
  }
  const blankRows = blank.map((review) => ({ reviewId: review.id, labels: [NO_POINTS_LABEL] }));
  if (withText.length === 0) {
    const labelled = await reviews.saveLabels(blankRows);
    logger.info({ leadId, reviews: labelled }, 'reviews without text labelled; no LLM call');
    return { status: 'LABELLED', reviews: labelled };
  }

  const task = await buildLabellingTask(withText, lead.reviewLabels);
  let answer: LabellingAnswer;
  try {
    ({ data: answer } = await llm.complete({
      organizationId: lead.organizationId,
      campaignId: lead.campaignId,
      leadId,
      task: 'REVIEW_LABELLING',
      system: task.system,
      user: task.user,
      schema: task.schema,
      maxTokens: task.maxTokens,
    }));
  } catch (error) {
    if (error instanceof SpendCapReachedError) {
      logger.warn({ leadId }, 'LLM monthly cap reached; reviews not labelled');
      return { status: 'CAP_REACHED', reason: error.reason };
    }
    if (error instanceof LlmOutputInvalidError || error instanceof LlmError) {
      logger.warn(
        { leadId, ...errorFields(error) },
        'review labelling failed; reviews left unlabelled',
      );
      return { status: 'FAILED' };
    }
    throw error;
  }

  const labelled = await reviews.saveLabels([...task.labelsByReview(answer), ...blankRows]);
  logger.info({ leadId, reviews: labelled }, 'reviews labelled');
  return { status: 'LABELLED', reviews: labelled };
}
