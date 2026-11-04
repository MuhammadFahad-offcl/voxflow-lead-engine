/**
 * Database access for campaigns: the only campaigns code that talks to Prisma.
 *
 * Serves: FR-1, FR-2, FR-3; hazeljs-conventions (repositories in front of the database).
 * Used by: apps/api/src/modules/campaigns/campaigns.service.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaProvider } from '../../db/prisma.provider.js';
import type { CampaignStatus, Prisma } from '../../generated/prisma/client.js';

// What every campaign read returns: the row plus the niche fields the summary needs.
const WITH_NICHE = { nicheProfile: { select: { slug: true, searchTerms: true } } } as const;

/** A campaign row with its niche's slug and search terms. */
export type CampaignWithNiche = Prisma.CampaignGetPayload<{ include: typeof WITH_NICHE }>;

/** What `create` needs: owner, niche version, city, areas and the precomputed search count. */
interface NewCampaign {
  organizationId: string;
  nicheProfileId: string;
  city: string;
  areas: string[];
  searchCount: number;
  /** Left out to take the database default (FR-2). */
  maxResultsPerSearch?: number;
}

/** A campaign's status pair: `pausedFrom` is set exactly while `status` is PAUSED. */
interface StatusPair {
  status: CampaignStatus;
  pausedFrom: CampaignStatus | null;
}

/** Reads and writes `Campaign` rows for the one v1 organization. */
@Injectable()
export class CampaignsRepository {
  /**
   * Wires the repository to the process's database client.
   * @param prisma - The process's Prisma client.
   */
  constructor(private readonly prisma: PrismaProvider) {}

  /**
   * Finds the organization campaigns belong to.
   *
   * Does not create it: `pnpm db:seed` does. v1 has exactly one organization.
   * @returns Its id, or null when the database has not been seeded.
   */
  async findOrganizationId(): Promise<string | null> {
    const organization = await this.prisma.organization.findFirst({
      orderBy: { createdAt: 'asc' },
      select: { id: true },
    });
    return organization?.id ?? null;
  }

  /**
   * Finds the newest version of a niche profile.
   * @param organizationId - Owner of the niche.
   * @param slug - Niche slug, e.g. "dental-clinic".
   * @returns The profile's id and search terms, or null when no version exists.
   */
  findLatestNiche(
    organizationId: string,
    slug: string,
  ): Promise<{ id: string; searchTerms: string[] } | null> {
    return this.prisma.nicheProfile.findFirst({
      where: { organizationId, slug },
      orderBy: { version: 'desc' },
      select: { id: true, searchTerms: true },
    });
  }

  /**
   * Inserts a campaign; status and the per-search cap take their database defaults.
   * @param data - The new campaign's fields.
   * @returns The new campaign with its niche.
   */
  create(data: NewCampaign): Promise<CampaignWithNiche> {
    return this.prisma.campaign.create({ data, include: WITH_NICHE });
  }

  /**
   * Lists campaigns, newest first.
   *
   * Does not paginate: v1 runs a handful of campaigns.
   * @param organizationId - Owner of the campaigns.
   * @returns Every campaign with its niche.
   */
  list(organizationId: string): Promise<CampaignWithNiche[]> {
    return this.prisma.campaign.findMany({
      where: { organizationId },
      // id breaks ties, so two campaigns created in the same millisecond keep one order.
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: WITH_NICHE,
    });
  }

  /**
   * Finds one campaign.
   * @param organizationId - Owner of the campaign.
   * @param id - Campaign id.
   * @returns The campaign with its niche, or null when it does not exist for this organization.
   */
  find(organizationId: string, id: string): Promise<CampaignWithNiche | null> {
    return this.prisma.campaign.findFirst({ where: { id, organizationId }, include: WITH_NICHE });
  }

  /**
   * Changes a campaign's status only if both its status and `pausedFrom` are still what the caller
   * read.
   *
   * Does not check the state machine: the service did. Guarding on both fields makes a concurrent
   * change lose cleanly: a resume that read "PAUSED from SCORING" cannot apply after the campaign
   * was resumed, moved on and paused again from a later status.
   * @param id - Campaign id.
   * @param read - Status pair the caller read.
   * @param data - Status pair to write, plus a cleared `pauseReason` on resume.
   * @returns True when the row was updated, false when it had already changed.
   */
  async updateStatusIf(
    id: string,
    read: StatusPair,
    data: StatusPair & { pauseReason?: null },
  ): Promise<boolean> {
    const { count } = await this.prisma.campaign.updateMany({
      where: { id, status: read.status, pausedFrom: read.pausedFrom },
      data,
    });
    return count === 1;
  }
}
