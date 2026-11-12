/**
 * Use cases behind the lead table: a page of a campaign's leads.
 *
 * Serves: FR-30 (lead table: filter, sort), FR-14 (evidence), FR-32 (status and error), US-14;
 * issue #16.
 * Used by: apps/api/src/modules/leads/lead-table.controller.ts, apps/api/src/modules/leads/leads.module.ts.
 */
import { Injectable, NotFoundError } from '@hazeljs/core';
import {
  LEAD_PAGE_SIZE,
  ScoreBreakdown,
  type LeadListQuery,
  type LeadPage,
  type LeadRow,
} from '@voxflow/shared';
import { LeadTableRepository, type LeadTableRow } from './lead-table.repository.js';

/**
 * Shapes a stored lead for the API.
 * @param row - The lead as the repository read it.
 * @returns The table row.
 * @throws ZodError when the stored breakdown does not match its schema.
 */
function toRow(row: LeadTableRow): LeadRow {
  const { scoreBreakdown, rating, ...lead } = row;
  return {
    ...lead,
    // Decimal(2,1) in the database; a plain number on the wire, e.g. 4.6.
    rating: rating === null ? null : rating.toNumber(),
    breakdown: scoreBreakdown === null ? null : ScoreBreakdown.parse(scoreBreakdown),
  };
}

/** Lead-table use cases. */
@Injectable()
export class LeadTableService {
  /**
   * Wires the use cases to the database.
   * @param leads - The lead table's reads.
   */
  constructor(private readonly leads: LeadTableRepository) {}

  /**
   * Reads one page of a campaign's leads.
   * @param campaignId - `Campaign.id`.
   * @param query - Validated filters, sort and page.
   * @returns The page, with the total across pages.
   * @throws NotFoundError when the campaign does not exist.
   */
  async page(campaignId: string, query: LeadListQuery): Promise<LeadPage> {
    await this.mustExist(campaignId);
    const { rows, total } = await this.leads.page(campaignId, query, LEAD_PAGE_SIZE);
    return { leads: rows.map(toRow), total, page: query.page, pageSize: LEAD_PAGE_SIZE };
  }

  // 404 for an unknown campaign, rather than an empty table that looks like "no leads yet".
  private async mustExist(campaignId: string): Promise<void> {
    if (!(await this.leads.campaignExists(campaignId))) {
      throw new NotFoundError(`Campaign "${campaignId}" not found`);
    }
  }
}
