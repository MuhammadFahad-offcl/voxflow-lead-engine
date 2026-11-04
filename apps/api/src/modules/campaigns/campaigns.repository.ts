/**
 * Database access for campaigns: the only campaigns code that talks to Prisma.
 *
 * Serves: FR-1, FR-2; hazeljs-conventions (repositories in front of the database).
 * Used by: apps/api/src/modules/campaigns/campaigns.service.ts.
 */
import { Injectable } from '@hazeljs/core';
import { PrismaProvider } from '../../db/prisma.provider.js';
import type { Prisma } from '../../generated/prisma/client.js';

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
}
