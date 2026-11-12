/**
 * The lead graph: one HazelJS `AgentGraph` run per lead, of function nodes
 * website → web context → review labels → score → END. Each run and its checkpoints are stored
 * through HazelJS's SQL durable run store (`agent_runs`, `agent_run_checkpoints`), and the run id
 * is kept on `Lead.graphRunId`.
 *
 * `AgentGraph.execute()` (2.0.13) keeps its state in memory and cannot resume, so a resumed or
 * retried lead starts a new run at its next step, chosen from the lead's status; every step skips
 * the work already stored, so a resume never pays twice (ADR-0001, update of 2026-11-12).
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
import type { PrismaProvider } from '../db/prisma.provider.js';
import type { ClaimedLead, LeadRunRepository } from '../db/lead-run.repository.js';
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

/** The `AgentRun.agentName` of every lead graph run, for the run timeline (FR-35). */
const GRAPH_NAME = 'lead-graph';
// Below the lead runner's lease, so a run ends before another pass may take its lead. Checked
// between nodes only: a node in flight finishes.
const GRAPH_TIMEOUT_MS = 10 * 60 * 1000;

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

/** What a lead graph run needs. */
export interface LeadGraphDeps {
  /** Builds the graph; its run store is the SQL durable run store. */
  runtime: Pick<AgentRuntime, 'createGraph'>;
  /** The same store, to record the run and its checkpoints. */
  store: Pick<DurableRunStore, 'runRepository' | 'checkpointService'>;
  runs: Pick<LeadRunRepository, 'startRun' | 'markEnriched' | 'release' | 'fail'>;
  website: EnrichWebsiteDeps;
  context: EnrichContextDeps;
  label: LabelReviewsDeps;
  score: ScoreDeps;
  logger: Logger;
}

/** How one lead's run ended. */
export type LeadRunOutcome =
  | { status: 'COMPLETED'; runId: string }
  | { status: 'PAUSED'; runId: string; step: LeadStep }
  | { status: 'FAILED'; runId: string; step: LeadStep }
  | { status: 'CLAIM_LOST'; runId: string };

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
  [LEAD_STEP.WEBSITE]: async (leadId) => {
    await enrichWebsite(deps.website, leadId);
    return { status: 'READ' };
  },
  [LEAD_STEP.CONTEXT]: async (leadId) => {
    const outcome = await enrichContext(deps.context, leadId);
    if (outcome.status === 'CAP_REACHED') throw new StepPausedError(outcome.reason);
    // A fixed sentence: the adapter's error may quote the search, and only the message is stored.
    if (outcome.status === 'FAILED') throw new Error('The web context search failed');
    await deps.runs.markEnriched(leadId);
    return outcome;
  },
  [LEAD_STEP.LABEL]: async (leadId) => {
    const outcome = await labelReviews(deps.label, leadId);
    if (outcome.status === 'CAP_REACHED') throw new StepPausedError(outcome.reason);
    if (outcome.status === 'FAILED') throw new Error('Review labelling failed');
    return outcome;
  },
  [LEAD_STEP.SCORE]: (leadId) => scoreStoredLead(deps.score, leadId),
});

/**
 * Builds one lead's graph: function nodes in a line, entering at `entry`.
 *
 * Does not add a conditional edge after score: with no node after it yet, both branches would end
 * the run. Cycle 2 adds it with the solution node.
 * @param deps - What the steps need.
 * @param leadId - `Lead.id`, closed over by every node.
 * @param runId - The `AgentRun` id each node's checkpoint is saved under.
 * @param entry - The first node to run.
 * @returns The compiled graph.
 */
const buildLeadGraph = (deps: LeadGraphDeps, leadId: string, runId: string, entry: LeadStep) => {
  const work = steps(deps);
  const order = Object.values(LEAD_STEP);
  const node = (step: LeadStep): FunctionNodeConfig => ({
    type: 'function',
    fn: async (state) => {
      const result = await work[step](leadId);
      // After the step's own write: a crash in between repeats a step that skips stored work.
      await deps.store.checkpointService.save(runId, { step, result }, order.indexOf(step) + 1);
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
  (Object.values(LEAD_STEP) as (string | undefined)[]).includes(node);

/**
 * Runs one claimed lead's graph and records the run in the durable run store.
 *
 * A previous run left unfinished (the worker stopped mid-run) is marked cancelled first. A node
 * error marks the lead FAILED with the node and the error's message, and the run failed; it never
 * reaches the caller, so one lead cannot stop its campaign (FR-32). A spend cap leaves the lead's
 * status as it is and the run suspended; the next pass tries again (FR-33).
 * Logs the lead id, run id, step and error name only.
 * @param deps - What the run needs.
 * @param lead - A lead this pass claimed.
 * @returns How the run ended, with its `AgentRun` id.
 * @throws Prisma errors when the run store or the lead cannot be written; the claim then expires
 * with its lease, and a later pass resumes the lead.
 */
export async function runLeadGraph(
  deps: LeadGraphDeps,
  lead: ClaimedLead,
): Promise<LeadRunOutcome> {
  const { runRepository } = deps.store;
  if (lead.graphRunId !== null) {
    const previous = await runRepository.get(lead.graphRunId);
    if (previous !== undefined && !isTerminalRunStatus(previous.status)) {
      await runRepository.updateStatus(previous.id, AgentRunStatus.CANCELLED, {
        error: { message: 'The worker stopped during this run; a new run resumed the lead' },
      });
    }
  }
  const entry = entryFor(lead);
  const runId = `lead_${randomUUID()}`;
  await runRepository.create({
    id: runId,
    agentName: GRAPH_NAME,
    input: { leadId: lead.id, entry },
    metadata: { campaignId: lead.campaignId },
  });
  await runRepository.updateStatus(runId, AgentRunStatus.RUNNING);
  if (!(await deps.runs.startRun(lead, runId))) {
    await runRepository.updateStatus(runId, AgentRunStatus.CANCELLED, {
      error: { message: 'Another pass took the lead after this claim expired' },
    });
    return { status: 'CLAIM_LOST', runId };
  }

  const log = { leadId: lead.id, runId };
  const result = await buildLeadGraph(deps, lead.id, runId, entry).execute(lead.id, {
    timeout: GRAPH_TIMEOUT_MS,
  });
  if (result.success) {
    await runRepository.updateStatus(runId, AgentRunStatus.COMPLETED, {
      output: result.state.data,
    });
    await deps.runs.release(lead);
    deps.logger.info(log, 'lead graph completed');
    return { status: 'COMPLETED', runId };
  }

  // The node running when the error came; the timeout and step limit fire between nodes.
  const node = result.state.currentNode;
  const step = isLeadStep(node) ? node : entry;
  const error = result.error ?? new Error('The lead graph failed without an error');
  if (error instanceof StepPausedError) {
    await runRepository.updateStatus(runId, AgentRunStatus.SUSPENDED, {
      error: { message: error.reason },
    });
    await deps.runs.release(lead);
    deps.logger.warn({ ...log, step }, 'lead graph paused by a spend cap');
    return { status: 'PAUSED', runId, step };
  }
  await runRepository.updateStatus(runId, AgentRunStatus.FAILED, {
    error: { message: error.message },
  });
  await deps.runs.fail(lead, step, error.message);
  deps.logger.error({ ...log, step, ...errorFields(error) }, 'lead graph step failed');
  return { status: 'FAILED', runId, step };
}
