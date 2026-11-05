/**
 * Database access for discovery: claims, pauses and the Apify spend so far.
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

/** Reads and writes what discovery needs. */
@Injectable()
export class DiscoveryRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

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
}
