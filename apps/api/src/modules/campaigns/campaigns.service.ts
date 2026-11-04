/**
 * Campaign use cases: create with its search grid, list, get, pause and resume.
 *
 * Serves: FR-1 (create), FR-2 (grid size, cap, duplicate rate), FR-3 (status changes).
 * Used by: apps/api/src/modules/campaigns/campaigns.controller.ts.
 */
import { ConflictError, HttpError, Injectable, NotFoundError } from '@hazeljs/core';
import type { CampaignSummary, CreateCampaignInput } from '@voxflow/shared';
import { canTransition } from './campaign-status.js';
import { CampaignsRepository, type CampaignWithNiche } from './campaigns.repository.js';

/**
 * Share of discovery results that were duplicates (FR-2), rounded to 2 decimals.
 *
 * Does not return money, so a rounded number is fine here.
 * @param foundCount - Every result discovery received, duplicates included.
 * @param duplicateCount - Results that matched a business already found.
 * @returns A rate from 0 to 1, or null when nothing has been found yet.
 */
export function duplicateRate(foundCount: number, duplicateCount: number): number | null {
  if (foundCount === 0) return null;
  return Math.round((duplicateCount / foundCount) * 100) / 100;
}

/**
 * Builds the API view of a campaign.
 * @param campaign - Row with its niche.
 * @returns The summary, with the grid split into its factors and the duplicate rate.
 */
function toSummary(campaign: CampaignWithNiche): CampaignSummary {
  return {
    id: campaign.id,
    nicheSlug: campaign.nicheProfile.slug,
    city: campaign.city,
    areas: campaign.areas,
    status: campaign.status,
    grid: {
      terms: campaign.nicheProfile.searchTerms.length,
      areas: campaign.areas.length,
      searches: campaign.searchCount,
    },
    maxResultsPerSearch: campaign.maxResultsPerSearch,
    foundCount: campaign.foundCount,
    duplicateCount: campaign.duplicateCount,
    duplicateRate: duplicateRate(campaign.foundCount, campaign.duplicateCount),
    filteredCount: campaign.filteredCount,
    createdAt: campaign.createdAt.toISOString(),
  };
}

/** Campaign use cases for the one v1 organization. */
@Injectable()
export class CampaignsService {
  /**
   * Wires the service to its repository.
   * @param repository - Campaign database access.
   */
  constructor(private readonly repository: CampaignsRepository) {}

  /**
   * Creates a campaign from the newest version of a niche, in DISCOVERING.
   *
   * Does not start discovery: the worker's campaign runner picks DISCOVERING campaigns up (#10, #15).
   * @param input - Validated body of `POST /campaigns`.
   * @returns The new campaign; `grid.searches` is search terms × areas.
   * @throws NotFoundError when no niche has that slug; HttpError (503) when the database is not
   * seeded.
   */
  async create(input: CreateCampaignInput): Promise<CampaignSummary> {
    const organizationId = await this.organizationId();
    const niche = await this.repository.findLatestNiche(organizationId, input.nicheSlug);
    if (niche === null) throw new NotFoundError(`Niche "${input.nicheSlug}" not found`);
    const campaign = await this.repository.create({
      organizationId,
      nicheProfileId: niche.id,
      city: input.city,
      areas: input.areas,
      searchCount: niche.searchTerms.length * input.areas.length,
    });
    return toSummary(campaign);
  }

  /**
   * Lists every campaign, newest first.
   * @returns The summaries.
   * @throws HttpError (503) when the database is not seeded.
   */
  async list(): Promise<CampaignSummary[]> {
    const campaigns = await this.repository.list(await this.organizationId());
    return campaigns.map(toSummary);
  }

  /**
   * Gets one campaign.
   * @param id - Campaign id.
   * @returns Its summary.
   * @throws NotFoundError when it does not exist; HttpError (503) when the database is not seeded.
   */
  async get(id: string): Promise<CampaignSummary> {
    return toSummary(await this.find(id));
  }

  /**
   * Pauses an active campaign and remembers its status for resume.
   * @param id - Campaign id.
   * @returns The paused campaign.
   * @throws NotFoundError when it does not exist; ConflictError when it is not active (already
   * paused, completed or failed) or changed while this ran; HttpError (503) when the database is
   * not seeded.
   */
  async pause(id: string): Promise<CampaignSummary> {
    const campaign = await this.find(id);
    if (!canTransition(campaign.status, 'PAUSED')) {
      throw new ConflictError(`A ${campaign.status} campaign cannot be paused`);
    }
    await this.changeStatus(campaign, { status: 'PAUSED', pausedFrom: campaign.status });
    return this.get(id);
  }

  /**
   * Resumes a paused campaign in the status it was paused from.
   * @param id - Campaign id.
   * @returns The resumed campaign.
   * @throws NotFoundError when it does not exist; ConflictError when it is not paused or changed
   * while this ran; HttpError (503) when the database is not seeded.
   */
  async resume(id: string): Promise<CampaignSummary> {
    const campaign = await this.find(id);
    // The database CHECK guarantees pausedFrom is set exactly while the status is PAUSED.
    const target = campaign.pausedFrom;
    if (campaign.status !== 'PAUSED' || target === null || !canTransition('PAUSED', target)) {
      throw new ConflictError(`A ${campaign.status} campaign cannot be resumed`);
    }
    await this.changeStatus(campaign, { status: target, pausedFrom: null });
    return this.get(id);
  }

  private async changeStatus(
    campaign: CampaignWithNiche,
    data: Parameters<CampaignsRepository['updateStatusIf']>[2],
  ): Promise<void> {
    const read = { status: campaign.status, pausedFrom: campaign.pausedFrom };
    if (!(await this.repository.updateStatusIf(campaign.id, read, data))) {
      throw new ConflictError('The campaign changed meanwhile; reload and try again');
    }
  }

  private async find(id: string): Promise<CampaignWithNiche> {
    const campaign = await this.repository.find(await this.organizationId(), id);
    if (campaign === null) throw new NotFoundError(`Campaign "${id}" not found`);
    return campaign;
  }

  private async organizationId(): Promise<string> {
    const id = await this.repository.findOrganizationId();
    // 503: the API works, but this database has not been set up yet.
    if (id === null) throw new HttpError(503, 'No organization found: run pnpm db:seed');
    return id;
  }
}
