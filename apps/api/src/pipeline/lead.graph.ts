/**
 * The lead graph: one HazelJS `AgentGraph` run per lead, of function nodes
 * website → web context → review labels → score → END. Each run and its checkpoints are stored
 * through HazelJS's SQL durable run store (`agent_runs`, `agent_run_checkpoints`), and the run id
 * is kept on `Lead.graphRunId`.
 *
 * `AgentGraph.execute()` (2.0.13) keeps its state in memory and cannot resume, so a resumed or
 * retried lead starts a new run at its next step, chosen from the lead's status, and every step
 * skips the work already stored. A paid call is repeated only when a crash falls between the call
 * and its save (accepted in the context and labelling steps). Each node first renews the runner's
 * claim, so no node starts, or pays, without holding the lead (ADR-0001, update of 2026-11-12).
 * Cycle 2 adds the solution and script nodes after score, with the COLD → END edge.
 *
 * Serves: FR-9–FR-15 (runs the steps), FR-32 (per-lead status, error, never stops the campaign),
 * FR-33 (a spend cap pauses the step), NFR-1, NFR-2, ADR-0001; issue #15.
 * Used by: apps/api/test/lead-graph.int.spec.ts; the lead runner (#15, next PR).
 */
import { randomUUID } from 'node:crypto';
import {
  AgentRunStatus,
  AgentRuntime,
  createSqlDurableRunStore,
  END,
  isTerminalRunStatus,
  LogLevel,
  type DurableRunStore,
  type FunctionNodeConfig,
  type PrismaAgentRunClientLike,
} from '@hazeljs/agent';
import type { ClaimedLead, LeadRunRepository } from '../db/lead-run.repository.js';
import type { PrismaProvider } from '../db/prisma.provider.js';
import { errorFields, type Logger } from '../logging/logger.js';
import { enrichContext, type EnrichContextDeps } from './enrich-context.step.js';
import { enrichWebsite, type EnrichWebsiteDeps } from './enrich.step.js';
import { labelReviews, type LabelReviewsDeps } from './label-reviews.step.js';
import { scoreStoredLead, type ScoreDeps } from './score.step.js';

/** The graph's nodes; a FAILED lead's `failedStep` is one of these. */
export const LEAD_STEP = {
  WEBSITE: 'ENRICH_WEBSITE',
  CONTEXT: 'ENRICH_CONTEXT',
  LABEL: 'LABEL_REVIEWS',
  SCORE: 'SCORE',
} as const;
type LeadStep = (typeof LEAD_STEP)[keyof typeof LEAD_STEP];
const ORDER: readonly LeadStep[] = Object.values(LEAD_STEP);
/** The lead and the lease value this pass holds; each renewal moves `claimedAt`. */
type HeldClaim = Pick<ClaimedLead, 'id' | 'claimedAt'>;

/** The `AgentRun.agentName` of every lead graph run, for the run timeline (FR-35). */
const GRAPH_NAME = 'lead-graph';

/** A step stopped by a spend cap (FR-33): the lead waits, it does not fail. */
class StepPausedError extends Error {
  /**
   * Builds the pause signal a node throws.
   * @param reason - The cap sentence for the run record; never business data.
   */
  constructor(readonly reason: string) {
    super(reason);
    this.name = 'StepPausedError';
  }
}

/** A step that failed with one of this file's fixed sentences, safe to show on the dashboard. */
class StepFailedError extends Error {
  /**
   * Builds the failure a node throws.
   * @param message - A fixed sentence; never text from a library, a page or a model.
   */
  constructor(message: string) {
    super(message);
    this.name = 'StepFailedError';
  }
}

/** The runner's claim on the lead ran out and another pass took it: stop before paying. */
class ClaimLostError extends Error {
  /** Builds the signal a node throws when it cannot renew the claim. */
  constructor() {
    super('Another pass took the lead after this claim expired');
    this.name = 'ClaimLostError';
  }
}

/** What a lead graph run needs. */
export interface LeadGraphDeps {
  /** Builds the graph; its run store is the SQL durable run store. */
  runtime: Pick<AgentRuntime, 'createGraph'>;
  /** The same store, to record the run and its checkpoints. */
  store: Pick<DurableRunStore, 'runRepository' | 'checkpointService'>;
  runs: Pick<LeadRunRepository, 'startRun' | 'renew' | 'markEnriched' | 'release' | 'fail'>;
  website: EnrichWebsiteDeps;
  context: EnrichContextDeps;
  label: LabelReviewsDeps;
  score: ScoreDeps;
  logger: Logger;
  /** The clock for claim renewals. */
  now: () => Date;
}

/** How one lead's run ended. */
export type LeadRunOutcome =
  | { status: 'COMPLETED'; runId: string }
  | { status: 'PAUSED'; runId: string; step: LeadStep }
  | { status: 'FAILED'; runId: string; step: LeadStep }
  | { status: 'STOPPED'; runId: string }
  | { status: 'CLAIM_LOST' };

/**
 * Builds the HazelJS runtime and SQL durable run store the lead graph runs on.
 *
 * Does not register any agent: the lead graph has function nodes only (Cycle 2 adds agents).
 * @param prisma - The process's Prisma client; it has the Agent OS models (`agentRun`, …).
 * @returns The runtime (graphs) and the store (runs, checkpoints), sharing one database.
 */
export function createLeadGraphRuntime(prisma: PrismaProvider): {
  runtime: AgentRuntime;
  store: DurableRunStore;
} {
  // HazelJS types each model as methods taking `unknown`; Prisma's generated methods are generic
  // over their arguments, so TypeScript cannot match the two. The calls are the same: the store
  // writes the Agent OS models copied from HazelJS's own schema (lead-graph.int.spec.ts runs it).
  const store = createSqlDurableRunStore(prisma as unknown as PrismaAgentRunClientLike);
  const runtime = new AgentRuntime({
    runRepository: store.runRepository,
    checkpointService: store.checkpointService,
    humanTaskService: store.humanTaskService,
    // Our pino logger reports runs; HazelJS's own console logger stays quiet below errors.
    logLevel: LogLevel.ERROR,
    enableMetrics: false,
  });
  return { runtime, store };
}

/**
 * Picks the node a lead's run starts at, from what is already stored.
 * @param lead - The claimed lead.
 * @returns ENRICHED leads start at labelling; a DISCOVERED lead whose site was read, or that has
 * none (discover stores NONE), starts at the web context; any other at the website.
 */
const entryFor = (lead: ClaimedLead): LeadStep => {
  if (lead.status === 'ENRICHED') return LEAD_STEP.LABEL;
  return lead.websiteStatus === 'PENDING' ? LEAD_STEP.WEBSITE : LEAD_STEP.CONTEXT;
};

// The step for each node: what it stores is in the database; what it returns goes in the checkpoint.
const steps = (deps: LeadGraphDeps): Record<LeadStep, (leadId: string) => Promise<object>> => ({
  [LEAD_STEP.WEBSITE]: async (leadId) => ({
    websiteStatus: await enrichWebsite(deps.website, leadId),
  }),
  [LEAD_STEP.CONTEXT]: async (leadId) => {
    const outcome = await enrichContext(deps.context, leadId);
    if (outcome.status === 'CAP_REACHED') throw new StepPausedError(outcome.reason);
    // FR-12 is "should": a failed search leaves the lead without context, never FAILED (#12).
    await deps.runs.markEnriched(leadId);
    return outcome;
  },
  [LEAD_STEP.LABEL]: async (leadId) => {
    const outcome = await labelReviews(deps.label, leadId);
    if (outcome.status === 'CAP_REACHED') throw new StepPausedError(outcome.reason);
    if (outcome.status === 'FAILED') throw new StepFailedError('Review labelling failed');
    return outcome;
  },
  [LEAD_STEP.SCORE]: (leadId) => scoreStoredLead(deps.score, leadId),
});

/**
 * Builds one lead's graph: function nodes in a line, entering at `entry`.
 *
 * Every node renews the claim first and throws {@link ClaimLostError} when it cannot.
 * Does not add a conditional edge after score: with no node after it yet, both branches would end
 * the run. Cycle 2 adds it with the solution node.
 * @param deps - What the steps need.
 * @param claim - The lead and the lease value this pass holds; each renewal updates it.
 * @param runId - The `AgentRun` id each node's checkpoint is saved under.
 * @param entry - The first node to run.
 * @returns The compiled graph.
 */
const buildLeadGraph = (deps: LeadGraphDeps, claim: HeldClaim, runId: string, entry: LeadStep) => {
  const work = steps(deps);
  const node = (step: LeadStep): FunctionNodeConfig => ({
    type: 'function',
    fn: async (state) => {
      const renewedAt = deps.now();
      if (!(await deps.runs.renew(claim, renewedAt))) throw new ClaimLostError();
      claim.claimedAt = renewedAt;
      const result = await work[step](claim.id);
      // After the step's own write: a crash in between repeats a step that skips stored work.
      await deps.store.checkpointService.save(runId, { step, result }, ORDER.indexOf(step) + 1);
      return { data: { ...state.data, [step]: result } };
    },
  });
  return deps.runtime
    .createGraph(GRAPH_NAME)
    .addNode(LEAD_STEP.WEBSITE, node(LEAD_STEP.WEBSITE))
    .addNode(LEAD_STEP.CONTEXT, node(LEAD_STEP.CONTEXT))
    .addNode(LEAD_STEP.LABEL, node(LEAD_STEP.LABEL))
    .addNode(LEAD_STEP.SCORE, node(LEAD_STEP.SCORE))
    .addEdge(LEAD_STEP.WEBSITE, LEAD_STEP.CONTEXT)
    .addEdge(LEAD_STEP.CONTEXT, LEAD_STEP.LABEL)
    .addEdge(LEAD_STEP.LABEL, LEAD_STEP.SCORE)
    .addEdge(LEAD_STEP.SCORE, END)
    .setEntryPoint(entry)
    .compile();
};

const isLeadStep = (node: string | undefined): node is LeadStep =>
  (ORDER as readonly (string | undefined)[]).includes(node);

/**
 * The sentence stored on a FAILED lead and its run: this file's own sentences as they are; any
 * other error as a fixed sentence with its name and code, because a library's message can quote
 * the data it was given (links, emails, names).
 * @param error - What the node threw.
 * @returns The sentence.
 */
const storedError = (error: Error): string => {
  if (error instanceof StepFailedError) return error.message;
  const { errorName, errorCode } = errorFields(error);
  const code = errorCode === null ? '' : ` (${errorCode})`;
  return `Unexpected ${errorName}${code} in this step`;
};

/**
 * Closes the lead's previous run when it never finished, so the timeline shows why.
 * @param deps - The run store.
 * @param previousRunId - `Lead.graphRunId` before this run, if any.
 */
const closePreviousRun = async (
  deps: LeadGraphDeps,
  previousRunId: string | null,
): Promise<void> => {
  if (previousRunId === null) return;
  const previous = await deps.store.runRepository.get(previousRunId);
  if (previous === undefined || isTerminalRunStatus(previous.status)) return;
  const message =
    previous.status === AgentRunStatus.SUSPENDED
      ? 'Paused at a spend cap; a new run resumed the lead'
      : 'The worker stopped during this run; a new run resumed the lead';
  await deps.store.runRepository.updateStatus(previous.id, AgentRunStatus.CANCELLED, {
    error: { message },
  });
};

/**
 * Runs one claimed lead's graph and records the run in the durable run store.
 *
 * A node error marks the lead FAILED with the node and a stored sentence, and the run failed; it
 * never reaches the caller, so one lead cannot stop its campaign (FR-32). A spend cap leaves the
 * lead's status as it is, the run suspended and the claim held, so the lease works as a back-off
 * and the lead is tried again once it runs out (FR-33). A stop between nodes (HazelJS's timeout or
 * step limit) leaves the lead to resume at its next step, and the run timed out. A lost claim
 * cancels the run and leaves the lead to the pass that holds it.
 * Logs the lead id, run id, step, and the error's name and code only.
 * @param deps - What the run needs.
 * @param lead - A lead this pass claimed.
 * @returns How the run ended, with its `AgentRun` id.
 * @throws Prisma errors from the writes around the graph (the run record, the lead's run id, its
 * final status); the claim then expires with its lease, and a later pass resumes the lead. Errors
 * inside a node do not throw: they fail the lead.
 */
export async function runLeadGraph(
  deps: LeadGraphDeps,
  lead: ClaimedLead,
): Promise<LeadRunOutcome> {
  const { runRepository } = deps.store;
  const claim: HeldClaim = { id: lead.id, claimedAt: lead.claimedAt };
  const runId = `lead_${randomUUID()}`;
  // Before the run record: a crash between the two leaves an id that no run has, not a run that
  // no lead points to and nothing would ever close.
  if (!(await deps.runs.startRun(claim, runId))) return { status: 'CLAIM_LOST' };
  await closePreviousRun(deps, lead.graphRunId);
  const entry = entryFor(lead);
  await runRepository.create({
    id: runId,
    agentName: GRAPH_NAME,
    input: { leadId: lead.id, entry },
    metadata: { campaignId: lead.campaignId },
  });
  await runRepository.updateStatus(runId, AgentRunStatus.RUNNING);

  const log = { leadId: lead.id, runId };
  const result = await buildLeadGraph(deps, claim, runId, entry).execute(lead.id);
  if (result.success) {
    await runRepository.updateStatus(runId, AgentRunStatus.COMPLETED, {
      output: result.state.data,
    });
    await deps.runs.release(claim);
    deps.logger.info(log, 'lead graph completed');
    return { status: 'COMPLETED', runId };
  }

  const error = result.error ?? new Error('The lead graph failed without an error');
  // HazelJS sets currentNode before running a node, so it names the node that threw. When that
  // node's result is already in the state, the error came between nodes (timeout, step limit).
  const node = result.state.currentNode;
  const step = isLeadStep(node) ? node : entry;
  if (error instanceof ClaimLostError) {
    await runRepository.updateStatus(runId, AgentRunStatus.CANCELLED, {
      error: { message: error.message },
    });
    deps.logger.warn({ ...log, step }, 'lead graph lost its claim');
    return { status: 'CLAIM_LOST' };
  }
  if (error instanceof StepPausedError) {
    await runRepository.updateStatus(runId, AgentRunStatus.SUSPENDED, {
      error: { message: error.reason },
    });
    deps.logger.warn({ ...log, step }, 'lead graph paused by a spend cap');
    return { status: 'PAUSED', runId, step };
  }
  if (Object.hasOwn(result.state.data, step)) {
    await runRepository.updateStatus(runId, AgentRunStatus.TIMED_OUT, {
      error: { message: storedError(error) },
    });
    await deps.runs.release(claim);
    deps.logger.warn({ ...log, step, ...errorFields(error) }, 'lead graph stopped between steps');
    return { status: 'STOPPED', runId };
  }
  const message = storedError(error);
  await runRepository.updateStatus(runId, AgentRunStatus.FAILED, { error: { message } });
  await deps.runs.fail(claim, step, message);
  deps.logger.error({ ...log, step, ...errorFields(error) }, 'lead graph step failed');
  return { status: 'FAILED', runId, step };
}
