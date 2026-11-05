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
import { errorFields, type Logger } from '../logging/logger.js';
import type { LeadSourcePort, PlaceSearch } from '../ports/lead-source.port.js';
import { findAreaPolygon, missingAreas, type AreaPolygons } from './area-polygons.js';
import { countChainNames, idealClientFilter } from './ideal-client-filter.js';
import {
  buildGrid,
  readSearchNote,
  runProblem,
  searchKey,
  searchNote,
  toLeadRow,
} from './search-plan.js';
import { capPauseReason, karachiDayStart } from './spend-cap.js';

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

/** A search this campaign already reserved, read back from its cost record. */
interface KnownSearch {
  recordId: string;
  /** Null when no run id was saved: the run may or may not exist. */
  runId: string | null;
  /** True once a pass paused so the founder could look for this search's run. */
  checkRequested: boolean;
  stored: boolean;
}

/** A search with a run to read. */
interface StartedRun {
  recordId: string;
  runId: string;
}

/**
 * Why a search could not go on. `uncertainRecordId` names a record whose run may exist; PAUSED means
 * storing the search already paused the campaign.
 */
type SearchStop =
  | { kind: 'PAUSE'; reason: string; uncertainRecordId?: string }
  | { kind: 'PAUSED' }
  | { kind: 'CLAIM_LOST' };

/** One grid cell with everything needed to run it. */
type GridCell = Pick<PlaceSearch, 'term' | 'area' | 'polygon'>;

// What every pause over a possible run tells the founder: the check comes before the resume.
const CHECK_FIRST =
  "Check the Apify console first. Resuming means you checked: a new run starts for this search, and the amount already reserved stays on the day's total.";

const readKnownSearches = async (
  repository: DiscoveryRepository,
  campaignId: string,
): Promise<Map<string, KnownSearch>> => {
  const known = new Map<string, KnownSearch>();
  for (const { id, note, units } of await repository.searchRecords(campaignId)) {
    const search = readSearchNote(note);
    // An abandoned record is closed: its search goes on under a newer record, or a new one.
    if (search === null || search.state === 'ABANDONED') continue;
    known.set(searchKey(search), {
      recordId: id,
      runId: search.runId,
      checkRequested: search.state === 'CHECK_APIFY',
      stored: units !== null,
    });
  }
  return known;
};

// The reservation is committed before the request goes out, and no transaction spans the request.
const startPaidRun = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  claim: Claim,
  cell: GridCell,
): Promise<SearchStop | StartedRun> => {
  const { repository, leadSource } = deps;
  const { term, area } = cell;
  const { organizationId, city, maxResultsPerSearch: maxResults } = campaign;
  const caps = SpendCaps.parse(campaign.organization.settings?.spendCaps);
  const capUsd = new Prisma.Decimal(caps.apifyDailyUsd);
  const chargeLimitUsd = leadSource.chargeLimitUsd(maxResults);
  const now = deps.now();
  const reservation = await repository.reserveWithinCap(claim, {
    organizationId,
    amountUsd: chargeLimitUsd,
    capUsd,
    dayStart: karachiDayStart(now),
    at: now,
    note: searchNote({ term, area, runId: null }),
  });
  if (reservation.outcome === 'CLAIM_LOST') return { kind: 'CLAIM_LOST' };
  if (reservation.outcome === 'OVER_CAP') {
    return { kind: 'PAUSE', reason: capPauseReason(reservation.spent, chargeLimitUsd, capUsd) };
  }
  const { recordId } = reservation;
  let runId: string;
  try {
    runId = await leadSource.start({ ...cell, city, maxResults, chargeLimitUsd });
  } catch (error) {
    deps.logger.error({ campaignId: campaign.id, ...errorFields(error) }, 'Apify start failed');
    // Not resumed by itself: the failed request may still have started a charging run.
    return {
      kind: 'PAUSE',
      reason: `Apify start failed for "${term}" in ${area}, but a run may exist. ${CHECK_FIRST}`,
      uncertainRecordId: recordId,
    };
  }
  try {
    await repository.saveRunId(recordId, runId);
  } catch (error) {
    deps.logger.error(
      { campaignId: campaign.id, runId, ...errorFields(error) },
      'run id not saved',
    );
    return {
      kind: 'PAUSE',
      reason: `Apify run ${runId} started for "${term}" in ${area}, but its id could not be saved. ${CHECK_FIRST}`,
      uncertainRecordId: recordId,
    };
  }
  return { recordId, runId };
};

// Decides what a known search needs next; only the founder's resume can lead to a new paid run.
const continueSearch = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  claim: Claim,
  cell: GridCell,
  known: KnownSearch,
): Promise<SearchStop | StartedRun> => {
  const { recordId, runId } = known;
  if (runId !== null) return { recordId, runId };
  if (!known.checkRequested) {
    return {
      kind: 'PAUSE',
      reason: `A paid run for "${cell.term}" in ${cell.area} may have started, but no run id was saved. ${CHECK_FIRST}`,
      uncertainRecordId: recordId,
    };
  }
  await deps.repository.abandonSearch(recordId);
  deps.logger.warn({ campaignId: campaign.id, recordId }, 'search abandoned on resume');
  return startPaidRun(deps, campaign, claim, cell);
};

const collectAndStore = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  claim: Claim,
  cell: GridCell,
  search: StartedRun,
): Promise<SearchStop | null> => {
  let collected;
  try {
    collected = await deps.leadSource.collect(search.runId);
  } catch (error) {
    deps.logger.error({ campaignId: campaign.id, ...errorFields(error) }, 'Apify read failed');
    return {
      kind: 'PAUSE',
      reason: `Could not read the Apify run for "${cell.term}" in ${cell.area}. Resuming reads it again without paying.`,
    };
  }
  const { organizationId, id: campaignId, city } = campaign;
  const owner = { organizationId, campaignId, area: cell.area, city };
  const reason = runProblem(collected, cell);
  const stored = await deps.repository.storeSearch({
    recordId: search.recordId,
    campaignId,
    rows: collected.items.map((item) => toLeadRow(item, owner)),
    costUsd: collected.costUsd,
    ...(reason === null ? {} : { pause: { claim, reason } }),
  });
  const { term, area } = cell;
  const { status, skippedCount } = collected;
  deps.logger.info({ campaignId, term, area, status, skippedCount, stored }, 'search stored');
  if (reason === null) return null;
  deps.logger.warn({ campaignId, reason }, 'campaign paused');
  return { kind: stored?.paused === true ? 'PAUSED' : 'CLAIM_LOST' };
};

// Picks a search up from wherever it got to; returns why it stopped, or null once it is stored.
const runSearch = async (
  deps: DiscoverDeps,
  campaign: DiscoveryCampaign,
  claim: Claim,
  cell: GridCell,
  known: KnownSearch | undefined,
): Promise<SearchStop | null> => {
  const search =
    known === undefined
      ? await startPaidRun(deps, campaign, claim, cell)
      : await continueSearch(deps, campaign, claim, cell, known);
  if ('kind' in search) return search;
  return collectAndStore(deps, campaign, claim, cell, search);
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
 * Safe to repeat: a search's `CostRecord` is the proof of what happened. It is written before the
 * start, holding the run's charge limit, by the same transaction that checks the daily cap; the run
 * id follows the start. A stored search is skipped, one with a run id is collected again, and only
 * a search with no record starts a paid run.
 * A record with no run id means a run may or may not exist, so this pauses instead of starting one
 * and the reason sends the founder to the Apify console. Resuming means "I checked": the record is
 * marked abandoned, keeps its reserved amount on the day's total, and a new run starts for that
 * search under a new reservation.
 * Does not know whether the founder really checked: resuming without checking can pay for one extra
 * run, capped by that run's limit and counted in the day's total.
 * Does not stop for one bad item, nor retry a failed start or a run that went wrong: what such a
 * run returned is stored and the campaign pauses with a reason. Resuming moves on to the next
 * search; paying for that search again is the founder's decision.
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
  const stop = async (claim: Claim): Promise<DiscoverResult> => {
    // Otherwise a campaign an operator paused and resumed would wait out the whole lease.
    await repository.releaseClaim(claim);
    return 'STOPPED';
  };
  const pause = async (
    reason: string,
    claim: Claim,
    uncertainRecordId?: string,
  ): Promise<DiscoverResult> => {
    deps.logger.warn({ campaignId: claim.id, reason }, 'campaign paused');
    const paused =
      uncertainRecordId === undefined
        ? await repository.pause(claim, reason)
        : await repository.pauseForCheck(claim, uncertainRecordId, reason);
    return paused ? 'PAUSED' : stop(claim);
  };
  const campaign = await repository.loadCampaign(claimed.id);
  const { city, areas } = campaign;
  const missing = missingAreas(polygons, city, areas);
  if (missing.length > 0) {
    return pause(`No polygon for ${missing.join(', ')}: add it to config/areas first.`, claimed);
  }

  let claim = claimed;
  const searches = await readKnownSearches(repository, campaign.id);
  for (const { term, area } of buildGrid(campaign.nicheProfile.searchTerms, areas)) {
    const known = searches.get(searchKey({ term, area }));
    if (known?.stored === true) continue;
    const renewed = await repository.renewClaim(claim, deps.now());
    if (renewed === null) return stop(claim);
    claim = renewed;
    const cell = cellOf(polygons, city, term, area);
    const stopped = await runSearch(deps, campaign, claim, cell, known);
    if (stopped?.kind === 'PAUSED') return 'PAUSED';
    if (stopped?.kind === 'CLAIM_LOST') return stop(claim);
    if (stopped !== null) return pause(stopped.reason, claim, stopped.uncertainRecordId);
  }
  return (await filterAndFinish(deps, campaign, claim)) ? 'ENRICHING' : stop(claim);
}
