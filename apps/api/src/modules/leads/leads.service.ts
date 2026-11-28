/**
 * Use cases behind the lead routes: one lead for its detail page, and retrying a FAILED lead from
 * its failed step.
 *
 * Serves: FR-32 (a failed lead shows a retry button; retry runs it again from the failed step),
 * FR-17 (a failed solution step retries at SOLUTION; the detail page shows the pick), FR-30 (lead
 * detail); issues #15, #19, #24.
 * Used by: apps/api/src/modules/leads/leads.controller.ts, apps/api/src/modules/leads/leads.module.ts.
 */
import { ConflictError, Injectable, NotFoundError } from '@hazeljs/core';
import { ScoreBreakdown, type LeadDetail } from '@voxflow/shared';
import { LEAD_STEP } from '../../pipeline/lead.graph.js';
import { LeadsRepository, type LeadDetailRow } from './leads.repository.js';

/** A re-queued lead, as the retry route returns it. */
export interface RetriedLead {
  id: string;
  /** Where its next graph run starts. */
  status: 'DISCOVERED' | 'ENRICHED' | 'SCORED';
}

/**
 * Picks the status a retried lead goes back to, so its next run starts at the failed step.
 * @param failedStep - `Lead.failedStep`.
 * @returns SCORED for a failure in the solution step (the runner starts it there again);
 * ENRICHED for labelling or scoring; DISCOVERED for enrichment or an unknown step (a run from the
 * start skips what is stored).
 */
export function retryStatusFor(failedStep: string | null): RetriedLead['status'] {
  if (failedStep === LEAD_STEP.SOLUTION) return 'SCORED';
  return failedStep === LEAD_STEP.LABEL || failedStep === LEAD_STEP.SCORE
    ? 'ENRICHED'
    : 'DISCOVERED';
}

/**
 * Turns a stored lead into the detail page's shape.
 * @param row - The lead as the repository reads it.
 * @returns The wire shape: plain numbers, ISO dates, and the Solution flattened.
 */
function toDetail(row: LeadDetailRow): LeadDetail {
  const { scoreBreakdown, rating, reviews, solution, ...lead } = row;
  return {
    ...lead,
    // Decimal(2,1) in the database; a plain number on the wire, e.g. 4.6.
    rating: rating === null ? null : rating.toNumber(),
    // A breakdown of the wrong shape shows as none rather than failing the whole page.
    breakdown: ScoreBreakdown.safeParse(scoreBreakdown).data ?? null,
    reviews: reviews.map((review) => ({
      ...review,
      publishedAt: review.publishedAt === null ? null : review.publishedAt.toISOString(),
    })),
    solution:
      solution === null
        ? null
        : {
            serviceSlug: solution.service.slug,
            serviceName: solution.service.name,
            reason: solution.reason,
            model: solution.model,
            // As stored: an id the lead no longer has is the page's to explain, not an error here.
            signalIds: solution.signalIds,
          },
  };
}

/** Lead use cases. */
@Injectable()
export class LeadsService {
  /**
   * Wires the use cases to the database.
   * @param leads - Lead rows.
   */
  constructor(private readonly leads: LeadsRepository) {}

  /**
   * Reads one lead for its detail page.
   *
   * Does not check that the Solution's cited signals still exist: a re-scored lead can cite a
   * deleted `Signal.id`, and the page shows that instead of hiding the pick.
   * @param id - `Lead.id`.
   * @returns The lead with its signals, reviews (no authors) and Solution.
   * @throws NotFoundError when there is no such lead; Prisma errors when the database cannot be read.
   */
  async detail(id: string): Promise<LeadDetail> {
    const row = await this.leads.findDetail(id);
    if (row === null) throw new NotFoundError(`Lead "${id}" not found`);
    return toDetail(row);
  }

  /**
   * Re-queues a FAILED lead from its failed step; the worker's lead runner picks it up within a
   * pass, while its campaign is ENRICHING or SCORING.
   *
   * A retry can pay again for a step that failed after a paid call (a bad model answer, for
   * example): the founder asks for that with this button.
   * Does not run the graph itself: the API never calls outside services for a lead (ADR-0002).
   * @param id - `Lead.id`.
   * @returns The lead's id and the status it starts again from.
   * @throws NotFoundError when there is no such lead; ConflictError when it is not FAILED or was
   * re-queued while this ran.
   */
  async retry(id: string): Promise<RetriedLead> {
    const lead = await this.leads.findFailure(id);
    if (lead === null) throw new NotFoundError(`Lead "${id}" not found`);
    if (lead.status !== 'FAILED') {
      throw new ConflictError(`Only a FAILED lead can be retried; this one is ${lead.status}`);
    }
    const status = retryStatusFor(lead.failedStep);
    if (!(await this.leads.requeue(id, status))) {
      throw new ConflictError('The lead changed while it was being retried');
    }
    return { id, status };
  }
}
