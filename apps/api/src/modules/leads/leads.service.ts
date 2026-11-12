/**
 * Use cases behind the lead routes: retrying a FAILED lead from its failed step.
 *
 * Serves: FR-32 (a failed lead shows a retry button; retry runs it again from the failed step);
 * issue #15.
 * Used by: apps/api/src/modules/leads/leads.controller.ts, apps/api/src/modules/leads/leads.module.ts.
 */
import { ConflictError, Injectable, NotFoundError } from '@hazeljs/core';
import { LEAD_STEP } from '../../pipeline/lead.graph.js';
import { LeadsRepository } from './leads.repository.js';

/** A re-queued lead, as the retry route returns it. */
export interface RetriedLead {
  id: string;
  /** Where its next graph run starts. */
  status: 'DISCOVERED' | 'ENRICHED';
}

/**
 * Picks the status a retried lead goes back to, so its next run starts at the failed step.
 * @param failedStep - `Lead.failedStep`.
 * @returns ENRICHED for a failure in labelling or scoring; DISCOVERED for enrichment or an
 * unknown step (a run from the start skips what is stored).
 */
export function retryStatusFor(failedStep: string | null): RetriedLead['status'] {
  return failedStep === LEAD_STEP.LABEL || failedStep === LEAD_STEP.SCORE
    ? 'ENRICHED'
    : 'DISCOVERED';
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
