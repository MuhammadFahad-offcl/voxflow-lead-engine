/**
 * `/leads` routes for the dashboard: retry a FAILED lead. Bound to 127.0.0.1 like every non-Vapi
 * route (ADR-0003).
 *
 * Serves: FR-32; issue #15.
 * Used by: apps/api/src/modules/leads/leads.module.ts; docs/http/leads.http.
 */
import { Controller, Param, Post, ValidationError } from '@hazeljs/core';
import { z } from 'zod';
import { LeadsService, type RetriedLead } from './leads.service.js';

// cuid ids are 25 characters; the limit only keeps junk out of logs and queries.
const LeadId = z.string().trim().min(1, 'id is required').max(64, 'id is too long');

/** `/leads` routes. */
@Controller('/leads')
export class LeadsController {
  /**
   * Wires the routes to the lead use cases.
   * @param leads - Lead use cases.
   */
  constructor(private readonly leads: LeadsService) {}

  /**
   * Re-queues a FAILED lead from its failed step (the dashboard's retry button).
   * @param id - Lead id from the path.
   * @returns 200 with the lead id and the status it starts again from.
   * @throws ValidationError (400) for a bad id; NotFoundError (404); ConflictError (409) when the
   * lead is not FAILED.
   */
  @Post('/:id/retry')
  retry(@Param('id') id: string): Promise<RetriedLead> {
    const parsed = LeadId.safeParse(id);
    if (!parsed.success) {
      throw new ValidationError(
        'Invalid lead id',
        parsed.error.issues.map((issue) => ({
          property: 'id',
          constraints: { [issue.code]: issue.message },
        })),
      );
    }
    return this.leads.retry(parsed.data);
  }
}
