/**
 * The discover step: runs a campaign's search grid and stores what it finds, safely repeatable.
 *
 * Serves: FR-5 to FR-8, FR-33, ADR-0010, ADR-0015 (pass 1; reviews are #12), NFR-1, NFR-2.
 * Used by: apps/api/src/scheduler/campaign-runner.ts, apps/api/test/discover.int.spec.ts.
 */
import { IdealClient, SpendCaps } from '@voxflow/shared';
import { CompassPlaceItem } from '../adapters/lead-source/apify-items.js';
import type { Claim, DiscoveryCampaign, DiscoveryRepository } from '../db/discovery.repository.js';
import { Prisma } from '../generated/prisma/client.js';
import type { Logger } from '../logging/logger.js';
import type { LeadSourcePort, PlaceSearch } from '../ports/lead-source.port.js';
import { findAreaPolygon, missingAreas, type AreaPolygons } from './area-polygons.js';
import { countChainNames, idealClientFilter } from './ideal-client-filter.js';
import { buildGrid, readSearchNote, searchKey, searchNote, toLeadRow } from './search-plan.js';
import { capPauseReason, karachiDayStart, wouldPassCap } from './spend-cap.js';

/** What the step needs from outside. */
export interface DiscoverDeps {
  repository: DiscoveryRepository;
  leadSource: LeadSourcePort;
  polygons: AreaPolygons;
  logger: Logger;
  /** The clock, so tests can fix the day the cap counts. */
  now: () => Date;
}

/** How a discover pass ended. */
type DiscoverResult = 'ENRICHING' | 'PAUSED' | 'STOPPED';

/** A search this campaign already started, read back from its cost record. */
interface StartedSearch {
  recordId: string;
  runId: string;
  stored: boolean;
}

/** One grid cell with everything needed to run it. */
type GridCell = Pick<PlaceSearch, 'term' | 'area' | 'polygon'>;

const readStartedSearches = async (
  repository: DiscoveryRepository,
  campaignId: string,
): Promise<Map<string, StartedSearch>> => {
  const started = new Map<string, StartedSearch>();
  for (const { id, note, units } of await repository.searchRecords(campaignId)) {
    const search = readSearchNote(note);
    const runId = search?.runId ?? null;
    if (search === null || runId === null) continue;
    const entry = { recordId: id, runId, stored: units !== null };
    started.set(searchKey(search), entry);
  }
  return started;
};

// Returns the started search, or why the campaign must pause instead.
const startPaidRun = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  cell: GridCell,
): Promise<{ reason: string } | StartedSearch> => {
  const { repository, leadSource } = deps;
  const { organizationId, city, maxResultsPerSearch: maxResults } = campaign;
  const caps = SpendCaps.parse(campaign.organization.settings?.spendCaps);
  const cap = new Prisma.Decimal(caps.apifyDailyUsd);
  const chargeLimitUsd = leadSource.chargeLimitUsd(maxResults);
  const spent = await repository.apifySpentSince(organizationId, karachiDayStart(deps.now()));
  if (wouldPassCap(spent, chargeLimitUsd, cap)) {
    return { reason: capPauseReason(spent, chargeLimitUsd, cap) };
  }
  let runId: string;
  try {
    runId = await leadSource.start({ ...cell, city, maxResults, chargeLimitUsd });
  } catch (error) {
    deps.logger.error({ campaignId: campaign.id, error: String(error) }, 'Apify start failed');
    // Not resumed by itself: the failed request may still have started a charging run.
    return {
      reason: `Apify start failed for "${cell.term}" in ${cell.area}. A run may exist: check the Apify console before resuming.`,
    };
  }
  const note = searchNote({ term: cell.term, area: cell.area, runId });
  const recordId = await repository.reserveSearch({
    organizationId,
    campaignId: campaign.id,
    amountUsd: chargeLimitUsd,
    note,
  });
  return { recordId, runId, stored: false };
};

const collectAndStore = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  cell: GridCell,
  search: StartedSearch,
): Promise<{ reason: string } | null> => {
  let collected;
  try {
    collected = await deps.leadSource.collect(search.runId);
  } catch (error) {
    deps.logger.error({ campaignId: campaign.id, error: String(error) }, 'Apify read failed');
    return {
      reason: `Could not read the Apify run for "${cell.term}" in ${cell.area}. Resuming reads it again without paying.`,
    };
  }
  const { organizationId, id: campaignId, city } = campaign;
  const owner = { organizationId, campaignId, area: cell.area, city };
  const stored = await deps.repository.storeSearch({
    recordId: search.recordId,
    campaignId,
    rows: collected.items.map((item) => toLeadRow(item, owner)),
    costUsd: collected.costUsd,
  });
  deps.logger.info({ campaignId, term: cell.term, area: cell.area, stored }, 'search stored');
  return null;
};

// Picks a search up from wherever it got to; returns why to pause, or null once it is stored.
const runSearch = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  cell: GridCell,
  known: StartedSearch | undefined,
): Promise<{ reason: string } | null> => {
  const search = known ?? (await startPaidRun(deps, campaign, cell));
  if ('reason' in search) return search;
  return collectAndStore(deps, campaign, cell, search);
};

const cellOf = (polygons: AreaPolygons, city: string, term: string, area: string): GridCell => {
  const polygon = findAreaPolygon(polygons, city, area);
  // The step checks every area before its first search, so this means a bug, not bad input.
  if (polygon === undefined) throw new Error(`No polygon for ${area}`);
  return { term, area, polygon };
};

const filterAndFinish = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  claim: Claim,
): Promise<boolean> => {
  const rules = IdealClient.parse(campaign.nicheProfile.idealClient);
  const places = await deps.repository.campaignPlaces(campaign.id);
  // Over every place, kept or not: a chain's count must not shrink on a repeat of this pass.
  const chains = countChainNames(places.map((place) => place.name));
  const rejections = places
    .filter((place) => place.status === 'DISCOVERED')
    .flatMap((place) => {
      const verdict = idealClientFilter(CompassPlaceItem.parse(place.rawPlace), rules, chains);
      return verdict.pass ? [] : [{ leadId: place.id, reason: verdict.reason }];
    });
  return deps.repository.finishDiscovery(claim, rejections);
};

/**
 * Runs what is left of a campaign's grid, then the filter, then moves it to ENRICHING.
 *
 * Safe to repeat: a search's `CostRecord` is the proof of what happened. A stored one is skipped,
 * an unfinished one is collected again from its saved run id, and only a search with no record
 * starts a paid run, after the claim is renewed and the daily cap is checked.
 * Does not close this one gap: a crash after Apify accepts a start and before the run id is saved
 * leaves no record, so that search starts a second paid run on restart. The first run is
 * bounded by its own charge limit and is not in the daily total.
 * Does not stop for one bad item, nor retry a failed start: it pauses with a reason, and resuming
 * is the founder's decision.
 * @param deps - Its dependencies.
 * @param claimed - The claim on the campaign, from the runner.
 * @returns ENRICHING when done; PAUSED when it paused the campaign; STOPPED when the claim was
 * lost, because an operator paused the campaign or another runner took it over.
 * @throws ZodError when the settings or niche JSON is invalid; Prisma errors from the database.
 */
export async function discoverCampaign(
  deps: DiscoverDeps,
  claimed: Claim,
): Promise<DiscoverResult> {
  const { repository, polygons } = deps;
  const pause = async (reason: string, claim: Claim): Promise<DiscoverResult> => {
    deps.logger.warn({ campaignId: claim.id, reason }, 'campaign paused');
    return (await repository.pause(claim, reason)) ? 'PAUSED' : 'STOPPED';
  };
  const stop = async (claim: Claim): Promise<DiscoverResult> => {
    // Otherwise a campaign an operator paused and resumed would wait out the whole lease.
    await repository.releaseClaim(claim);
    return 'STOPPED';
  };
  const campaign = await repository.loadCampaign(claimed.id);
  const { city, areas } = campaign;
  const missing = missingAreas(polygons, city, areas);
  if (missing.length > 0) {
    return pause(`No polygon for ${missing.join(', ')}: add it to config/areas first.`, claimed);
  }

  let claim = claimed;
  const started = await readStartedSearches(repository, campaign.id);
  for (const { term, area } of buildGrid(campaign.nicheProfile.searchTerms, areas)) {
    const known = started.get(searchKey({ term, area }));
    if (known?.stored === true) continue;
    const renewed = await repository.renewClaim(claim, deps.now());
    if (renewed === null) return stop(claim);
    claim = renewed;
    const failure = await runSearch(deps, campaign, cellOf(polygons, city, term, area), known);
    if (failure !== null) return pause(failure.reason, claim);
  }
  return (await filterAndFinish(deps, campaign, claim)) ? 'ENRICHING' : stop(claim);
}
