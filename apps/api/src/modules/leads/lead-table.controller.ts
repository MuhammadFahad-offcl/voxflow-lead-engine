/**
 * `/campaigns/:id/leads` routes for the dashboard's lead table. Bound to
 * 127.0.0.1 like every non-Vapi route (ADR-0003).
 *
 * Serves: FR-30 (lead table: filter, sort, paging), US-14; issue #16.
 * Used by: apps/api/src/modules/leads/leads.module.ts; docs/http/leads.http.
 */
import { Controller, Get, Param, Query, ValidationError } from '@hazeljs/core';
import { LeadListQuery, type LeadPage } from '@voxflow/shared';
import { z } from 'zod';
import { LeadTableService } from './lead-table.service.js';

// cuid ids are 25 characters; the limit only keeps junk out of logs and queries.
const CampaignId = z.string().trim().min(1, 'id is required').max(64, 'id is too long');

/**
 * Validates the path id and the query string.
 * @param id - Campaign id from the path.
 * @param query - The raw query string values.
 * @returns Both, parsed.
 * @throws ValidationError (400) naming each bad field, never echoing its value.
 */
function parse(id: string, query: unknown): { campaignId: string; query: LeadListQuery } {
  const campaignId = CampaignId.safeParse(id);
  const parsed = LeadListQuery.safeParse(query ?? {});
  if (campaignId.success && parsed.success)
    return { campaignId: campaignId.data, query: parsed.data };
  const issues = [
    ...(campaignId.success
      ? []
      : campaignId.error.issues.map((issue) => ({ ...issue, path: ['id'] }))),
    ...(parsed.success ? [] : parsed.error.issues),
  ];
  throw new ValidationError(
    'Invalid lead table request',
    issues.map((issue) => ({
      property: issue.path.join('.') || '(query)',
      constraints: { [issue.code]: issue.message },
    })),
  );
}

/** `/campaigns/:id/leads` routes. */
@Controller('/campaigns')
export class LeadTableController {
  /**
   * Wires the routes to the lead-table use cases.
   * @param table - Lead-table use cases.
   */
  constructor(private readonly table: LeadTableService) {}

  /**
   * One page (50 rows) of a campaign's leads, with each lead's signals and evidence.
   * @param id - Campaign id from the path.
   * @param query - `tier`, `status`, `area`, `minScore`, `maxScore`, `sort` (score, name or
   * reviews), `dir` (asc or desc) and `page`.
   * @returns 200 with the page and the total across pages.
   * @throws ValidationError (400) for a bad id or filter; NotFoundError (404) for an unknown campaign.
   */
  @Get('/:id/leads')
  page(@Param('id') id: string, @Query() query: unknown): Promise<LeadPage> {
    const request = parse(id, query);
    return this.table.page(request.campaignId, request.query);
  }
}
