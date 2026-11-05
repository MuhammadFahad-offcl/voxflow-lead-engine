/**
 * Database access for discovery: claims, the per-search cost records, and storing places.
 *
 * Serves: FR-3, FR-5, FR-7, FR-8, FR-33; hazeljs-conventions (repositories, atomic worker claims).
 * Used by: apps/api/src/pipeline/discover.step.ts, apps/api/src/scheduler/campaign-runner.ts.
 */
import { Injectable } from '@hazeljs/core';
import { Prisma, type CostRecord } from '../generated/prisma/client.js';
import { TEMPORARILY_CLOSED_REASON } from '../pipeline/ideal-client-filter.js';
import { readSearchNote } from '../pipeline/search-plan.js';
import { wouldPassCap } from '../pipeline/spend-cap.js';
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

/** A finished search and what it returned, for {@link DiscoveryRepository.storeSearch}. */
interface SearchToStore {
  recordId: string;
  campaignId: string;
  rows: Prisma.LeadCreateManyInput[];
  openPlaceIds?: readonly string[];
  costUsd: Prisma.Decimal | null;
  pause?: { claim: Claim; reason: string };
}

/** How a search's results counted. */
interface StoredCounts {
  created: number;
  reopened: number;
  duplicates: number;
}

/** What {@link DiscoveryRepository.reserveWithinCap} decided. */
export type Reservation =
  | { outcome: 'RESERVED'; recordId: string }
  | { outcome: 'OVER_CAP'; spent: Prisma.Decimal }
  | { outcome: 'CLAIM_LOST' };

// The rows only the live holder of a claim can match.
const heldBy = (claim: Claim) =>
  ({
    id: claim.id,
    status: 'DISCOVERING',
    discoveryClaimedAt: claim.claimedAt,
  }) satisfies Prisma.CampaignWhereInput;

const pausedBecause = (reason: string) =>
  ({
    status: 'PAUSED',
    pausedFrom: 'DISCOVERING',
    pauseReason: reason,
    discoveryClaimedAt: null,
  }) satisfies Prisma.CampaignUpdateManyMutationInput;

// One statement, because a second runner may be writing the run id into the same note.
const setSearchState = (
  client: Pick<Prisma.TransactionClient, '$executeRaw'>,
  recordId: string,
  state: 'CHECK_APIFY' | 'ABANDONED',
): Promise<number> =>
  client.$executeRaw`UPDATE "CostRecord"
    SET note = jsonb_set(note::jsonb, '{state}', to_jsonb(${state}::text))::text
    WHERE id = ${recordId}`;

// Gives open places filtered out as temporarily closed back to the pipeline, under this campaign:
// the campaign that first found one may be long finished, and nothing would ever enrich it there.
const reopenPlaces = async (
  tx: Prisma.TransactionClient,
  campaignId: string,
  openRows: readonly Prisma.LeadCreateManyInput[],
): Promise<number> => {
  const [first] = openRows;
  if (first === undefined) return 0;
  const { organizationId } = first;
  const closed = await tx.lead.findMany({
    where: {
      organizationId,
      placeId: { in: openRows.map((row) => row.placeId) },
      status: 'FILTERED_OUT',
      filterReason: TEMPORARILY_CLOSED_REASON,
    },
    select: { id: true, placeId: true },
  });
  const fresh = new Map(openRows.map((row) => [row.placeId, row]));
  for (const { id, placeId } of closed) {
    await tx.lead.update({
      where: { id },
      data: { ...fresh.get(placeId), campaignId, status: 'DISCOVERED', filterReason: null },
    });
  }
  return closed.length;
};

// Marks the search done and adds its places and counts; the caller holds the record's row.
const writeSearch = async (
  tx: Prisma.TransactionClient,
  search: SearchToStore,
): Promise<StoredCounts> => {
  const { recordId, campaignId, rows, openPlaceIds = [], costUsd } = search;
  await tx.costRecord.update({
    where: { id: recordId },
    data: { units: rows.length, ...(costUsd === null ? {} : { amountUsd: costUsd }) },
  });
  const created = await tx.lead.createManyAndReturn({
    data: rows,
    skipDuplicates: true,
    select: { placeId: true },
  });
  const createdIds = new Set(created.map(({ placeId }) => placeId));
  const open = new Set(openPlaceIds);
  const repeats = rows.filter(({ placeId }) => open.has(placeId) && !createdIds.has(placeId));
  const reopened = await reopenPlaces(tx, campaignId, repeats);
  const duplicates = rows.length - created.length - reopened;
  await tx.campaign.update({
    where: { id: campaignId },
    data: { foundCount: { increment: rows.length }, duplicateCount: { increment: duplicates } },
  });
  return { created: created.length, reopened, duplicates };
};

// An operator's pause has no reason, and a reason already there is the one the founder should read.
const addPauseReason = async (
  tx: Prisma.TransactionClient,
  campaignId: string,
  reason: string | undefined,
): Promise<boolean> => {
  if (reason === undefined) return false;
  const { count } = await tx.campaign.updateMany({
    where: { id: campaignId, status: 'PAUSED', pausedFrom: 'DISCOVERING', pauseReason: null },
    data: { pauseReason: reason },
  });
  return count === 1;
};

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
   * Extends a claim before each search, so a live run is not taken for an abandoned one.
   *
   * Does not succeed when the campaign left DISCOVERING (an operator paused it) or another runner
   * took over the lease: both mean this runner must stop.
   * @param claim - The claim held.
   * @param now - The new lease time.
   * @returns The renewed claim, or null when it is lost.
   */
  async renewClaim(claim: Claim, now: Date): Promise<Claim | null> {
    const { count } = await this.prisma.campaign.updateMany({
      where: heldBy(claim),
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
      where: heldBy(claim),
      data: pausedBecause(reason),
    });
    return count === 1;
  }

  /**
   * Pauses a campaign over a search whose paid run may exist, marking it for the founder's check.
   *
   * One transaction, so a later pass can trust the mark: CHECK_APIFY on a campaign that is
   * discovering again can only mean the founder read this reason and resumed.
   * @param claim - The claim held.
   * @param recordId - The search's `CostRecord.id`.
   * @param reason - Shown on the dashboard.
   * @returns True when it paused; false when the claim was already lost, and nothing changed.
   */
  pauseForCheck(claim: Claim, recordId: string, reason: string): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const { count } = await tx.campaign.updateMany({
        where: heldBy(claim),
        data: pausedBecause(reason),
      });
      if (count === 1) await setSearchState(tx, recordId, 'CHECK_APIFY');
      return count === 1;
    });
  }

  /**
   * Lists a campaign's Apify cost records: one per search reserved, started, stored or abandoned.
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
   * @param client - The transaction to read in; by default, none.
   * @returns The total in US dollars.
   */
  async apifySpentSince(
    organizationId: string,
    since: Date,
    client: Pick<Prisma.TransactionClient, 'costRecord'> = this.prisma,
  ): Promise<Prisma.Decimal> {
    const { _sum: sum } = await client.costRecord.aggregate({
      where: { organizationId, service: 'APIFY', at: { gte: since } },
      _sum: { amountUsd: true },
    });
    return sum.amountUsd ?? new Prisma.Decimal(0);
  }

  /**
   * Checks the daily cap and reserves a run's charge limit in one transaction, before any start.
   *
   * The amount is the limit until the true charge is known, so a crashed run still counts.
   * The advisory lock makes an organization's runners take turns, so a second one sees the first's
   * reservation. The claim is checked under it and that row stays locked until commit, so a runner
   * whose lease another took over can reserve nothing.
   * Does not start the run, and the lock ends with this call: the caller makes its Apify request
   * after this returns, never inside the transaction.
   * @param claim - The claim held; the record belongs to its campaign.
   * @param reservation - What to reserve and the limits to reserve it under.
   * @param reservation.organizationId - Owner of the spend.
   * @param reservation.amountUsd - The run's charge limit, in US dollars.
   * @param reservation.capUsd - The daily cap, in US dollars.
   * @param reservation.dayStart - When the capped day began.
   * @param reservation.at - The record's time, on the caller's clock.
   * @param reservation.note - From `searchNote`, with a null run id.
   * @returns The new record's id, or what stopped it: over the cap, or the claim lost.
   */
  reserveWithinCap(
    claim: Claim,
    reservation: {
      organizationId: string;
      amountUsd: Prisma.Decimal;
      capUsd: Prisma.Decimal;
      dayStart: Date;
      at: Date;
      note: string;
    },
  ): Promise<Reservation> {
    const { organizationId, amountUsd, capUsd, dayStart, at, note } = reservation;
    const lockName = `apify-spend:${organizationId}`;
    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${lockName}, 0))`;
      // Writes the same value: this only proves the claim and locks its row.
      const { count } = await tx.campaign.updateMany({
        where: heldBy(claim),
        data: { discoveryClaimedAt: claim.claimedAt },
      });
      if (count === 0) return { outcome: 'CLAIM_LOST' };
      const spent = await this.apifySpentSince(organizationId, dayStart, tx);
      if (wouldPassCap(spent, amountUsd, capUsd)) return { outcome: 'OVER_CAP', spent };
      const { id } = await tx.costRecord.create({
        data: { organizationId, campaignId: claim.id, service: 'APIFY', amountUsd, at, note },
        select: { id: true },
      });
      return { outcome: 'RESERVED', recordId: id };
    });
  }

  /**
   * Writes a started run's id into its reservation, so a restart collects instead of paying again.
   *
   * Does not check the claim or the record's state: the run exists whoever holds the campaign now,
   * so its id must be kept, even on an abandoned record that {@link storeSearch} will refuse.
   * @param recordId - The search's `CostRecord.id`.
   * @param runId - The id Apify gave the run.
   */
  async saveRunId(recordId: string, runId: string): Promise<void> {
    // One statement, because a second runner may be writing the state into the same note.
    await this.prisma.$executeRaw`UPDATE "CostRecord"
      SET note = jsonb_set(note::jsonb, '{runId}', to_jsonb(${runId}::text))::text
      WHERE id = ${recordId}`;
  }

  /**
   * Closes a search the founder resumed after being asked to check the Apify console.
   *
   * Does not touch the amount: a run may exist, so the reservation stays on that day's total.
   * @param recordId - The search's `CostRecord.id`.
   */
  async abandonSearch(recordId: string): Promise<void> {
    await setSearchState(this.prisma, recordId, 'ABANDONED');
  }

  /**
   * Stores one finished search in a single transaction: its leads, its counts and its true charge.
   *
   * A pause rides in the same transaction: the search counts as done from here on, so a crash
   * between the two would lose the only word that it went wrong.
   * Setting `units` is what marks the search done. The record's row is locked first, so a second
   * runner that collected the same run waits there, finds `units` set and adds nothing.
   * Refuses a record that was abandoned, because a newer record covers its search, and a campaign
   * that is not discovering, because a late worker must not change a campaign that moved on. The
   * refused run keeps its reserved amount and nothing is marked done, so a campaign that resumes
   * reads the same run again without paying. The caller logs the run id.
   * When a pause cannot apply because the campaign is already paused from DISCOVERING with no
   * reason, as an operator's pause is, the reason is written there: the founder reads it before
   * resuming. Does not overwrite a reason that is already set.
   * Does not touch places already stored (FR-7), with one exception: a place filtered out as
   * temporarily closed that this search shows open moves to this campaign with its fresh data, back
   * in DISCOVERED, so the filter judges it again at the end of the pass. It counts as new here, not
   * as a duplicate; the campaign that first found it keeps its counts.
   * @param search - The search and what it returned.
   * @param search.recordId - Its `CostRecord.id`.
   * @param search.campaignId - `Campaign.id`.
   * @param search.rows - One lead row per result, repeats included.
   * @param search.openPlaceIds - The results whose listing shows them open, from `isOpen`.
   * @param search.costUsd - True charge in US dollars; null keeps the reserved amount.
   * @param search.pause - Given when the run went wrong: what to pause on.
   * @param search.pause.claim - The claim held.
   * @param search.pause.reason - Shown on the dashboard.
   * @returns How many results were new, reopened or duplicates, and whether the campaign paused;
   * `refused` when nothing was stored, with whether the reason was written; null when already
   * stored.
   */
  storeSearch(
    search: SearchToStore,
  ): Promise<
    (StoredCounts & { paused: boolean }) | { refused: true; reasonSaved: boolean } | null
  > {
    const { recordId, campaignId, pause } = search;
    return this.prisma.$transaction(async (tx) => {
      // Writes the same value: this only proves the status and locks the row, before the record's
      // row as pauseForCheck does, so the two cannot deadlock.
      const { count: discovering } = await tx.campaign.updateMany({
        where: { id: campaignId, status: 'DISCOVERING' },
        data: { status: 'DISCOVERING' },
      });
      // Locked, because abandonSearch may be closing this record right now.
      const [record] = await tx.$queryRaw<Pick<CostRecord, 'note' | 'units'>[]>`
        SELECT note, units FROM "CostRecord" WHERE id = ${recordId} FOR UPDATE`;
      if (record?.units !== null) {
        await addPauseReason(tx, campaignId, pause?.reason);
        return null;
      }
      if (discovering === 0 || readSearchNote(record.note)?.state === 'ABANDONED') {
        return { refused: true, reasonSaved: await addPauseReason(tx, campaignId, pause?.reason) };
      }
      const counts = await writeSearch(tx, search);
      if (pause === undefined) return { ...counts, paused: false };
      const { count: paused } = await tx.campaign.updateMany({
        where: heldBy(pause.claim),
        data: pausedBecause(pause.reason),
      });
      return { ...counts, paused: paused === 1 };
    });
  }

  /**
   * Lists the places a campaign stored, with what the filter needs.
   * @param campaignId - Campaign id.
   * @returns Every lead this campaign found first or reopened.
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
        where: heldBy(claim),
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
