/**
 * `/leads` routes for the dashboard: one lead for its detail page, and retry a FAILED lead. Bound
 * to 127.0.0.1 like every non-Vapi route (ADR-0003).
 *
 * Serves: FR-32, issue #15; FR-30 (lead detail), issue #24.
 * Used by: apps/api/src/modules/leads/leads.module.ts; docs/http/leads.http.
 */
import { Controller, Get, Param, Post, ValidationError } from '@hazeljs/core';
import type { LeadDetail } from '@voxflow/shared';
import { z } from 'zod';
import { LeadsService, type RetriedLead } from './leads.service.js';

// cuid ids are 25 characters; the limit only keeps junk out of logs and queries.
const LeadId = z.string().trim().min(1, 'id is required').max(64, 'id is too long');

/**
 * Validates a lead id from the path.
 * @param id - The raw path value.
 * @returns The trimmed id.
 * @throws ValidationError (400) naming the `id` field; the value is never echoed.
 */
function leadIdOf(id: string): string {
  const parsed = LeadId.safeParse(id);
  if (parsed.success) return parsed.data;
  throw new ValidationError(
    'Invalid lead id',
    parsed.error.issues.map((issue) => ({
      property: 'id',
      constraints: { [issue.code]: issue.message },
    })),
  );
}

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
    return this.leads.retry(leadIdOf(id));
  }

  /**
   * One lead for the dashboard's detail page.
   * @param id - Lead id from the path.
   * @returns 200 with the lead's facts, score, signals, reviews (no authors) and Solution.
   * @throws ValidationError (400) for a bad id; NotFoundError (404) for an unknown lead.
   */
  @Get('/:id')
  detail(@Param('id') id: string): Promise<LeadDetail> {
    return this.leads.detail(leadIdOf(id));
  }
}
