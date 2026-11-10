/**
 * Database access for the web context part of enrichment: what a lead needs for its search, the
 * Perplexity spend so far today, and storing the context with its cost.
 *
 * Serves: FR-12, FR-33, NFR-4; issue #12.
 * Used by: apps/api/src/pipeline/enrich-context.step.ts, apps/api/test/enrich-context.int.spec.ts.
 */
import { Injectable } from '@hazeljs/core';
import { BusinessContext, SpendCaps } from '@voxflow/shared';
import { Prisma, type LeadStatus } from '../generated/prisma/client.js';
import { PrismaProvider } from './prisma.provider.js';

/** What the step reads about a lead before searching. */
export interface LeadForContext {
  organizationId: string;
  campaignId: string;
  name: string;
  area: string | null;
  city: string | null;
  website: string | null;
  status: LeadStatus;
  /** True once a search was stored, even one that found nothing. */
  hasContext: boolean;
}

/** Reads and writes a lead's business context and its cost. */
@Injectable()
export class LeadContextRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Reads what the step needs about a lead.
   * @param leadId - `Lead.id`.
   * @returns The lead's owner, campaign, search words, status and whether it has a context.
   * @throws Prisma's not-found error when there is no such lead.
   */
  async forContext(leadId: string): Promise<LeadForContext> {
    const { businessContext, ...lead } = await this.prisma.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: {
        organizationId: true,
        campaignId: true,
        name: true,
        area: true,
        city: true,
        website: true,
        status: true,
        businessContext: true,
      },
    });
    return { ...lead, hasContext: businessContext !== null };
  }

  /**
   * Gives the organization's daily Perplexity cap and what it has spent since a moment.
   * @param organizationId - Owner of the spend.
   * @param since - Start of the capped day.
   * @returns The cap and the spend, in US dollars.
   * @throws Prisma's not-found error when the organization has no settings; ZodError when its
   * `spendCaps` are invalid.
   */
  async dailyCap(
    organizationId: string,
    since: Date,
  ): Promise<{ capUsd: Prisma.Decimal; spentUsd: Prisma.Decimal }> {
    const { spendCaps } = await this.prisma.settings.findUniqueOrThrow({
      where: { organizationId },
      select: { spendCaps: true },
    });
    const { _sum: sum } = await this.prisma.costRecord.aggregate({
      where: { organizationId, service: 'PERPLEXITY_SEARCH', at: { gte: since } },
      _sum: { amountUsd: true },
    });
    return {
      capUsd: new Prisma.Decimal(SpendCaps.parse(spendCaps).perplexityDailyUsd),
      spentUsd: sum.amountUsd ?? new Prisma.Decimal(0),
    };
  }

  /**
   * Stores a paid search's context and its cost record in one transaction.
   *
   * Keeps the first context when two runs raced: the second is still paid for, so its cost is
   * recorded either way.
   * @param lead - Which lead, and whose spend it is.
   * @param lead.id - `Lead.id`.
   * @param lead.organizationId - Owner of the spend.
   * @param lead.campaignId - The campaign the cost belongs to.
   * @param context - What the search found; may be empty.
   * @param costUsd - What the request cost, in US dollars.
   * @throws ZodError when the context does not match BusinessContext, and nothing is written.
   */
  async saveContext(
    lead: { id: string; organizationId: string; campaignId: string },
    context: BusinessContext,
    costUsd: Prisma.Decimal,
  ): Promise<void> {
    // A JSON column is checked against its schema on every write (docs/database.md).
    const businessContext = BusinessContext.parse(context);
    await this.prisma.$transaction([
      this.prisma.lead.updateMany({
        where: { id: lead.id, businessContext: { equals: Prisma.DbNull } },
        data: { businessContext },
      }),
      this.spendRecord(lead, costUsd, businessContext.sources.length),
    ]);
  }

  /**
   * Records the cost of a search that may have been billed but gave no context, e.g. one that
   * timed out. The lead's context stays empty.
   *
   * Counts the full price against the daily cap, because the service may have billed it.
   * @param lead - Which lead, and whose spend it is.
   * @param lead.id - `Lead.id`.
   * @param lead.organizationId - Owner of the spend.
   * @param lead.campaignId - The campaign the cost belongs to.
   * @param costUsd - The most the request could have cost, in US dollars.
   */
  async recordSpend(
    lead: { id: string; organizationId: string; campaignId: string },
    costUsd: Prisma.Decimal,
  ): Promise<void> {
    await this.spendRecord(lead, costUsd, 0);
  }

  private spendRecord(
    lead: { id: string; organizationId: string; campaignId: string },
    amountUsd: Prisma.Decimal,
    units: number,
  ) {
    return this.prisma.costRecord.create({
      data: {
        organizationId: lead.organizationId,
        campaignId: lead.campaignId,
        leadId: lead.id,
        service: 'PERPLEXITY_SEARCH',
        amountUsd,
        units,
      },
    });
  }
}
