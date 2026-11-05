/**
 * Database access for discovery: claims, the per-search cost records, and storing places.
 *
 * Serves: FR-3, FR-5, FR-7, FR-8, FR-33; hazeljs-conventions (repositories, atomic worker claims).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/scheduler/campaign-runner.ts.
 */
import { Injectable } from '@hazeljs/core';
import { Prisma, type CostRecord } from '../generated/prisma/client.js';
import { PrismaProvider } from './prisma.provider.js';

/** A campaign held by one runner; `claimedAt` is the lease value only that runner knows. */
export interface Claim {
  id: string;
  claimedAt: Date;
}

// What discovery reads: the campaign, its niche's rules and terms, and the organization's caps.
const FOR_DISCOVERY = {
  nicheProfile: { select: { searchTerms: true, idealClient: true } },
  organization: { select: { settings: { select: { spendCaps: true } } } },
} as const;

/** A campaign with everything discovery reads. */
export type DiscoveryCampaign = Prisma.CampaignGetPayload<{ include: typeof FOR_DISCOVERY }>;

/** A search's cost record: `units` stays null until the search is stored. */
export type SearchRecord = Pick<CostRecord, 'id' | 'note' | 'units'>;

/** One place that failed the ideal-client filter. */
interface Rejection {
  leadId: string;
  reason: string;
}

/** Reads and writes what discovery needs. */
@Injectable()
export class DiscoveryRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Claims the oldest campaign waiting for discovery, or one whose runner's lease ran out.
   *
   * The UPDATE repeats the condition, so when two runners pick the same campaign Postgres makes
   * the second wait and re-check: it matches nothing, and only one claim comes back.
   * @param now - The lease time; it is also the claim's proof of ownership.
   * @param leaseMs - How old a claim must be to count as abandoned, in milliseconds.
   * @returns The claim, or null when nothing is free or another runner won.
   */
  async claimNext(now: Date, leaseMs: number): Promise<Claim | null> {
    const claimable = {
      status: 'DISCOVERING',
      OR: [
        { discoveryClaimedAt: null },
        { discoveryClaimedAt: { lt: new Date(now.getTime() - leaseMs) } },
      ],
    } satisfies Prisma.CampaignWhereInput;
    const candidate = await this.prisma.campaign.findFirst({
      where: claimable,
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    if (candidate === null) return null;
    const claimed = await this.prisma.campaign.updateManyAndReturn({
      where: { id: candidate.id, ...claimable },
      data: { discoveryClaimedAt: now },
      select: { id: true },
    });
    return claimed.length === 1 ? { id: candidate.id, claimedAt: now } : null;
  }

  /**
   * Reads a campaign for discovery.
   * @param id - Campaign id.
   * @returns The campaign with its niche and settings.
   * @throws Prisma's not-found error when it does not exist.
   */
  loadCampaign(id: string): Promise<DiscoveryCampaign> {
    return this.prisma.campaign.findUniqueOrThrow({ where: { id }, include: FOR_DISCOVERY });
  }

  /**
   * Extends a claim, the check that makes a paid start safe.
   *
   * Does not succeed when the campaign left DISCOVERING (an operator paused it) or another runner
   * took over the lease: both mean this runner must stop.
   * @param claim - The claim held.
   * @param now - The new lease time.
   * @returns The renewed claim, or null when it is lost.
   */
  async renewClaim(claim: Claim, now: Date): Promise<Claim | null> {
    const { count } = await this.prisma.campaign.updateMany({
      where: { id: claim.id, status: 'DISCOVERING', discoveryClaimedAt: claim.claimedAt },
      data: { discoveryClaimedAt: now },
    });
    return count === 1 ? { id: claim.id, claimedAt: now } : null;
  }

  /**
   * Gives a claim up, so the campaign need not wait for the lease to run out.
   * @param claim - The claim held.
   */
  async releaseClaim(claim: Claim): Promise<void> {
    await this.prisma.campaign.updateMany({
      where: { id: claim.id, discoveryClaimedAt: claim.claimedAt },
      data: { discoveryClaimedAt: null },
    });
  }

  /**
   * Pauses a campaign the runner holds, and says why.
   * @param claim - The claim held.
   * @param reason - Shown on the dashboard.
   * @returns True when it paused; false when the claim was already lost.
   */
  async pause(claim: Claim, reason: string): Promise<boolean> {
    const { count } = await this.prisma.campaign.updateMany({
      where: { id: claim.id, status: 'DISCOVERING', discoveryClaimedAt: claim.claimedAt },
      data: {
        status: 'PAUSED',
        pausedFrom: 'DISCOVERING',
        pauseReason: reason,
        discoveryClaimedAt: null,
      },
    });
    return count === 1;
  }

  /**
   * Lists a campaign's Apify cost records, each one search started or stored.
   * @param campaignId - Campaign id.
   * @returns The records.
   */
  searchRecords(campaignId: string): Promise<SearchRecord[]> {
    return this.prisma.costRecord.findMany({
      where: { campaignId, service: 'APIFY' },
      select: { id: true, note: true, units: true },
    });
  }

  /**
   * Adds up Apify spend since a moment, reservations of unfinished runs included.
   * @param organizationId - Owner of the spend.
   * @param since - Start of the period.
   * @returns The total in US dollars.
   */
  async apifySpentSince(organizationId: string, since: Date): Promise<Prisma.Decimal> {
    const { _sum: sum } = await this.prisma.costRecord.aggregate({
      where: { organizationId, service: 'APIFY', at: { gte: since } },
      _sum: { amountUsd: true },
    });
    return sum.amountUsd ?? new Prisma.Decimal(0);
  }

  /**
   * Saves a started run. The amount is its limit until the true charge is known, so a crashed
   * run still counts against the daily cap.
   * @param data - Owner, campaign, limit in US dollars, and the search note.
   * @param data.organizationId - `Organization.id`.
   * @param data.campaignId - `Campaign.id`.
   * @param data.amountUsd - The run's charge limit.
   * @param data.note - From `searchNote`.
   * @returns The new record's id.
   */
  async reserveSearch(data: {
    organizationId: string;
    campaignId: string;
    amountUsd: Prisma.Decimal;
    note: string;
  }): Promise<string> {
    const { id } = await this.prisma.costRecord.create({
      data: { ...data, service: 'APIFY' },
      select: { id: true },
    });
    return id;
  }

  /**
   * Stores one finished search in a single transaction: its leads, its counts and its true charge.
   *
   * Setting `units` is what marks the search done. It comes first and only a null matches, so a
   * second runner that collected the same run waits on the row, matches nothing and adds nothing.
   * Does not touch places already stored: `skipDuplicates` leaves them as they are (FR-7).
   * @param search - The search and what it returned.
   * @param search.recordId - Its `CostRecord.id`.
   * @param search.campaignId - `Campaign.id`.
   * @param search.rows - One lead row per result, repeats included.
   * @param search.costUsd - True charge in US dollars; null keeps the reserved amount.
   * @returns How many results were new and how many were duplicates; null when already stored.
   */
  storeSearch(search: {
    recordId: string;
    campaignId: string;
    rows: Prisma.LeadCreateManyInput[];
    costUsd: Prisma.Decimal | null;
  }): Promise<{ created: number; duplicates: number } | null> {
    const { recordId, campaignId, rows, costUsd } = search;
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.costRecord.updateMany({
        where: { id: recordId, units: null },
        data: { units: rows.length, ...(costUsd === null ? {} : { amountUsd: costUsd }) },
      });
      if (count === 0) return null;
      const created = await tx.lead.createManyAndReturn({
        data: rows,
        skipDuplicates: true,
        select: { id: true },
      });
      const duplicates = rows.length - created.length;
      await tx.campaign.update({
        where: { id: campaignId },
        data: { foundCount: { increment: rows.length }, duplicateCount: { increment: duplicates } },
      });
      return { created: created.length, duplicates };
    });
  }

  /**
   * Lists the places a campaign stored, with what the filter needs.
   * @param campaignId - Campaign id.
   * @returns Every lead this campaign found first.
   */
  campaignPlaces(
    campaignId: string,
  ): Promise<{ id: string; name: string; status: string; rawPlace: Prisma.JsonValue }[]> {
    return this.prisma.lead.findMany({
      where: { campaignId },
      select: { id: true, name: true, status: true, rawPlace: true },
    });
  }

  /**
   * Applies the filter's verdicts and moves the campaign on, all or nothing.
   *
   * The claim is checked first, so a lost claim changes no lead, and the row stays locked until
   * this commits. One update per distinct reason, not per lead: 8,000 single updates ran past
   * Prisma's 5-second transaction limit.
   * `filteredCount` is counted from the rows, not added to, so repeating this cannot inflate it.
   * @param claim - The claim held.
   * @param rejections - The places to mark FILTERED_OUT.
   * @returns True when the campaign moved to ENRICHING; false when the claim was lost.
   */
  finishDiscovery(claim: Claim, rejections: readonly Rejection[]): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.campaign.updateMany({
        where: { id: claim.id, status: 'DISCOVERING', discoveryClaimedAt: claim.claimedAt },
        data: { status: 'ENRICHING', discoveryClaimedAt: null },
      });
      if (count === 0) return false;
      for (const [reason, group] of Map.groupBy(rejections, (rejection) => rejection.reason)) {
        await tx.lead.updateMany({
          where: { id: { in: group.map((rejection) => rejection.leadId) } },
          data: { status: 'FILTERED_OUT', filterReason: reason },
        });
      }
      const filteredCount = await tx.lead.count({
        where: { campaignId: claim.id, status: 'FILTERED_OUT' },
      });
      await tx.campaign.update({ where: { id: claim.id }, data: { filteredCount } });
      return true;
    });
  }
}
