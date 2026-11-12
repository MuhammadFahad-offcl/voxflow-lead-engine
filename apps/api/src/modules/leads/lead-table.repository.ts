/**
 * Database access for the lead table: one campaign's leads, filtered, sorted and paged, with their
 * signals; or all of them, for the CSV export.
 *
 * Serves: FR-30 (lead table), FR-14 (evidence), US-14, NFR-3 (reads by the campaignId index, signals
 * in one query); issue #16.
 * Used by: apps/api/src/modules/leads/lead-table.service.ts, apps/api/src/modules/leads/leads.module.ts.
 */
import { Injectable } from '@hazeljs/core';
import type { LeadListQuery } from '@voxflow/shared';
import { PrismaProvider } from '../../db/prisma.provider.js';
import type { Prisma } from '../../generated/prisma/client.js';

const ROW = {
  id: true,
  name: true,
  area: true,
  phone: true,
  phoneType: true,
  website: true,
  rating: true,
  reviewCount: true,
  score: true,
  tier: true,
  status: true,
  failedStep: true,
  error: true,
  scoreBreakdown: true,
  signals: {
    select: { key: true, dimension: true, points: true, evidence: true, sourceUrl: true },
    // Highest points first; the key keeps one order between equal points.
    orderBy: [{ points: 'desc' }, { key: 'asc' }],
  },
} as const satisfies Prisma.LeadSelect;

/** A lead as the table reads it. */
export type LeadTableRow = Prisma.LeadGetPayload<{ select: typeof ROW }>;

/**
 * The WHERE clause for the filters.
 * @param campaignId - `Campaign.id`.
 * @param query - The parsed filters.
 * @returns The condition.
 */
const whereOf = (campaignId: string, query: LeadListQuery): Prisma.LeadWhereInput => ({
  campaignId,
  ...(query.tier === undefined ? {} : { tier: query.tier }),
  ...(query.status === undefined ? {} : { status: query.status }),
  ...(query.area === undefined ? {} : { area: { equals: query.area, mode: 'insensitive' } }),
  ...(query.minScore === undefined && query.maxScore === undefined
    ? {}
    : {
        score: {
          ...(query.minScore === undefined ? {} : { gte: query.minScore }),
          ...(query.maxScore === undefined ? {} : { lte: query.maxScore }),
        },
      }),
});

/**
 * The ORDER BY for the sort. Unscored leads and leads without a review count sort last either way;
 * the name and then the id break ties, so pages never overlap.
 * @param query - The parsed sort and direction.
 * @returns The order.
 */
const orderOf = (query: LeadListQuery): Prisma.LeadOrderByWithRelationInput[] => {
  const ties: Prisma.LeadOrderByWithRelationInput[] = [{ name: 'asc' }, { id: 'asc' }];
  if (query.sort === 'name') return [{ name: query.dir ?? 'asc' }, { id: 'asc' }];
  const column = query.sort === 'reviews' ? 'reviewCount' : 'score';
  return [{ [column]: { sort: query.dir ?? 'desc', nulls: 'last' } }, ...ties];
};

/** Reads the lead table. */
@Injectable()
export class LeadTableRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Tells whether a campaign exists.
   * @param campaignId - `Campaign.id`.
   * @returns True when it does.
   * @throws Prisma errors when the database cannot be read.
   */
  async campaignExists(campaignId: string): Promise<boolean> {
    return (await this.prisma.campaign.count({ where: { id: campaignId } })) === 1;
  }

  /**
   * Reads one page of a campaign's leads, and how many match in all.
   * @param campaignId - `Campaign.id`.
   * @param query - Filters, sort and page.
   * @param pageSize - Rows per page.
   * @returns The page's rows and the total.
   * @throws Prisma errors when the database cannot be read.
   */
  async page(
    campaignId: string,
    query: LeadListQuery,
    pageSize: number,
  ): Promise<{ rows: LeadTableRow[]; total: number }> {
    const where = whereOf(campaignId, query);
    const [rows, total] = await this.prisma.$transaction([
      this.prisma.lead.findMany({
        where,
        orderBy: orderOf(query),
        skip: (query.page - 1) * pageSize,
        take: pageSize,
        select: ROW,
      }),
      this.prisma.lead.count({ where }),
    ]);
    return { rows, total };
  }

  /**
   * Reads every lead of a campaign that matches the filters, in the table's order, for the CSV.
   *
   * Does not page: the export is exactly the filtered rows (FR-30), a few thousand at most in v1.
   * @param campaignId - `Campaign.id`.
   * @param query - Filters and sort; the page is ignored.
   * @returns The rows.
   * @throws Prisma errors when the database cannot be read.
   */
  all(campaignId: string, query: LeadListQuery): Promise<LeadTableRow[]> {
    return this.prisma.lead.findMany({
      where: whereOf(campaignId, query),
      orderBy: orderOf(query),
      select: ROW,
    });
  }
}
