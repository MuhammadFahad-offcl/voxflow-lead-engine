/**
 * The solution agent: a HazelJS `@Agent` with one `@Tool`, `searchCatalog`, that picks the one
 * catalog service removing a lead's biggest evidenced pain (FR-17). Its model calls go through
 * `GatedLlmProvider`, so the monthly cap, cost records and demo replay apply. The runner checks
 * the pick, retries once with the problems, and otherwise reports NEEDS_REVIEW.
 *
 * Serves: FR-17, US-5, NFR-9, ADR-0001 (HazelJS agents), ADR-0006; issue #19.
 * Used by: apps/api/src/pipeline/lead.graph.ts (#19 part 2), apps/api/src/agents/solution.agent.spec.ts.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Agent, AgentError, AgentErrorCode, Tool, type AgentRuntime } from '@hazeljs/agent';
import { SolutionAnswer } from '@voxflow/shared';
import { z } from 'zod';
import type { Prisma } from '../generated/prisma/client.js';
import { newAgentLlmScope, runInAgentLlmScope } from '../llm/gated-llm.provider.js';
import { LlmOutputInvalidError } from '../llm/llm.service.js';
import { checkSolutionPick } from './solution-validation.js';

/** The agent's name in the runtime. */
export const SOLUTION_AGENT = 'solution';

// From src or dist alike: both sit two levels below apps/api.
const SYSTEM_PROMPT = await readFile(
  resolve(import.meta.dirname, '../../src/agents/prompts/solution.md'),
  'utf8',
);
// The tool returns 5 services; a pick cites up to 4 signals in one sentence.
const SERVICES_RETURNED = 5;
const MAX_TOKENS = 600;
// The strongest signals' evidence, PAIN first, is what the catalog is searched with.
const SEARCH_SIGNALS = 3;
// A tool turn, then the answer; 4 leaves room for one extra tool call. Passed to execute(): the
// runtime ignores the @Agent's own maxSteps (it uses the call's option, else 10).
const MAX_STEPS = 4;

/** One catalog service as searchCatalog returns it: no database id, so prompts replay anywhere. */
export interface CatalogMatch {
  slug: string;
  name: string;
  problem: string;
  fittingSignals: string[];
}

/** Finds the active catalog services closest to a text, closest first. */
export type CatalogSearch = (text: string, k: number) => Promise<CatalogMatch[]>;

/** The lead the agent works on, with its evidenced signals (points > 0). */
export interface SolutionLead {
  organizationId: string;
  campaignId: string;
  leadId: string;
  name: string;
  area: string;
  tier: string;
  score: number;
  signals: { key: string; dimension: string; points: number; evidence: string }[];
}

/**
 * How a run ended. `costUsd` covers the model turns that got an answer; a turn that failed the
 * schema twice is recorded by the gate but not counted here, so the lead's `CostRecord` rows are
 * the full cost.
 */
export type SolutionOutcome =
  | {
      kind: 'pick';
      serviceSlug: string;
      reason: string;
      /** Signal keys; the caller maps them to `Signal.id`s. */
      signalKeys: string[];
      model: string;
      costUsd: Prisma.Decimal;
    }
  | { kind: 'noStrongSignal'; reason: string; model: string; costUsd: Prisma.Decimal }
  | { kind: 'needsReview'; problems: string[]; costUsd: Prisma.Decimal };

// What the tool needs and records during one agent run; HazelJS passes the tool only its input.
interface SolutionRun {
  lead: SolutionLead;
  retrievedSlugs: string[];
  /** The tool's own error: HazelJS catches tool errors and lets the model carry on. */
  failure: Error | null;
}
const runs = new AsyncLocalStorage<SolutionRun>();

/** Picks one catalog service for a lead's biggest evidenced pain. */
@Agent({
  name: SOLUTION_AGENT,
  description: 'Picks the one catalog service for a lead’s biggest evidenced pain (FR-17).',
  systemPrompt: SYSTEM_PROMPT,
})
class SolutionAgent {
  /**
   * Wires the tool to the catalog.
   * @param search - Embeds a text and finds the closest active services.
   */
  constructor(private readonly search: CatalogSearch) {}

  /**
   * Searches the catalog with the evidence of the lead's strongest signals, PAIN first.
   *
   * Does not take input from the model: the evidence comes from the run's lead, so the model cannot
   * steer the search away from what the reviews and website show.
   * @returns The 5 closest active services; their slugs are kept for checking the pick.
   * @throws Error when called outside {@link runSolutionAgent}; errors from the embedder or database,
   * also kept on the run so the runner rethrows them (HazelJS would swallow them).
   */
  @Tool({
    name: 'searchCatalog',
    description:
      'Returns the 5 catalog services closest to the clinic’s strongest evidence. Takes no input.',
    schema: z.object({}),
  })
  async searchCatalog(): Promise<CatalogMatch[]> {
    const run = runs.getStore();
    if (run === undefined) throw new Error('searchCatalog called outside a solution run');
    const painFirst = (dimension: string) => (dimension === 'PAIN' ? 0 : 1);
    const evidence = run.lead.signals
      .toSorted((a, b) => painFirst(a.dimension) - painFirst(b.dimension) || b.points - a.points)
      .slice(0, SEARCH_SIGNALS)
      .map(({ evidence: text }) => text)
      .join('\n');
    try {
      const matches = await this.search(evidence, SERVICES_RETURNED);
      run.retrievedSlugs = matches.map(({ slug }) => slug);
      return matches;
    } catch (error) {
      run.failure ??= error instanceof Error ? error : new Error(String(error));
      throw error;
    }
  }
}

/**
 * Registers the solution agent on a runtime whose LLM provider is `GatedLlmProvider`.
 * @param runtime - Built with `GATED_RUNTIME_OPTIONS`.
 * @param search - What the agent's tool searches the catalog with.
 */
export function registerSolutionAgent(
  runtime: Pick<AgentRuntime, 'registerAgent' | 'registerAgentInstance'>,
  search: CatalogSearch,
): void {
  runtime.registerAgent(SolutionAgent as new (...args: unknown[]) => unknown);
  runtime.registerAgentInstance(SOLUTION_AGENT, new SolutionAgent(search));
}

// The agent's input: the lead and its signals, by key; no database ids, so prompts replay anywhere.
const describeLead = (lead: SolutionLead): string =>
  [
    `Clinic: ${lead.name} (${lead.area}), tier ${lead.tier}, score ${String(lead.score)}.`,
    'Signals (cite them by key):',
    ...lead.signals.map(
      (signal) =>
        `- ${signal.key} (${signal.dimension}, ${String(signal.points)} points): ${signal.evidence}`,
    ),
  ].join('\n');

// The gate only lets JSON through; a missing answer (invalid twice) reads as null.
const parseJson = (text: string | undefined): unknown => {
  try {
    return JSON.parse(text ?? 'null');
  } catch {
    return null;
  }
};

// One agent run: the answer, or the problems when it broke FR-17's rules or the schema.
const attempt = async (
  runtime: Pick<AgentRuntime, 'execute'>,
  lead: SolutionLead,
  input: string,
): Promise<{
  answer: SolutionAnswer | null;
  problems: string[];
  model: string;
  costUsd: Prisma.Decimal;
}> => {
  const scope = newAgentLlmScope({
    organizationId: lead.organizationId,
    campaignId: lead.campaignId,
    leadId: lead.leadId,
    task: 'SOLUTION',
    answer: SolutionAnswer,
    maxTokens: MAX_TOKENS,
  });
  const run: SolutionRun = { lead, retrievedSlugs: [], failure: null };
  let response: string | undefined;
  let stepsExceeded = false;
  try {
    const result = await runInAgentLlmScope(scope, () =>
      runs.run(run, () =>
        runtime.execute(SOLUTION_AGENT, input, { maxSteps: MAX_STEPS, enableMemory: false }),
      ),
    );
    response = result.response;
  } catch (error) {
    // HazelJS wraps the gate's error; the original says what happened (cap, LLM failure).
    const cause = run.failure ?? scope.failure ?? error;
    stepsExceeded = cause instanceof AgentError && cause.code === AgentErrorCode.MAX_STEPS_EXCEEDED;
    if (!stepsExceeded && !(cause instanceof LlmOutputInvalidError)) throw cause;
  }
  // A failed search is an outage, not a weak lead: it must not end as an exit status.
  if (run.failure !== null) throw run.failure;
  const model = scope.models.at(-1) ?? 'unknown';
  if (stepsExceeded) {
    return {
      answer: null,
      problems: [
        `No final answer within ${String(MAX_STEPS)} steps: call searchCatalog once, then answer.`,
      ],
      model,
      costUsd: scope.costUsd,
    };
  }
  const parsed = SolutionAnswer.safeParse(parseJson(response));
  if (!parsed.success) {
    return {
      answer: null,
      problems: ['The answer did not match the required JSON shape twice.'],
      model,
      costUsd: scope.costUsd,
    };
  }
  const answer = parsed.data;
  const check =
    'noStrongSignal' in answer
      ? { ok: true as const }
      : checkSolutionPick(answer, {
          retrievedSlugs: run.retrievedSlugs,
          leadSignals: lead.signals,
        });
  return { answer, problems: check.ok ? [] : check.problems, model, costUsd: scope.costUsd };
};

/**
 * Runs the solution agent for one lead, checks the answer, and retries once with its problems.
 *
 * Does not write anything: the caller stores the Solution or the lead's exit status. Each model
 * call has already been capped and recorded against the lead by the gate.
 * @param runtime - A runtime with {@link registerSolutionAgent} done.
 * @param lead - The lead and its evidenced signals.
 * @returns The pick, no strong signal, or needs review after two bad answers; with the cost.
 * @throws SpendCapReachedError or LlmError from the gate, and the embedder's or database's errors
 * from the tool, unwrapped; other HazelJS errors as they come.
 */
export async function runSolutionAgent(
  runtime: Pick<AgentRuntime, 'execute'>,
  lead: SolutionLead,
): Promise<SolutionOutcome> {
  const input = describeLead(lead);
  const first = await attempt(runtime, lead, input);
  const outcome =
    first.problems.length === 0
      ? first
      : await attempt(
          runtime,
          lead,
          [
            input,
            '',
            'Your previous answer was rejected:',
            ...first.problems.map((p) => '- ' + p),
          ].join('\n'),
        ).then((second) => ({ ...second, costUsd: second.costUsd.plus(first.costUsd) }));
  const { answer, problems, model, costUsd } = outcome;
  if (answer === null || problems.length > 0) return { kind: 'needsReview', problems, costUsd };
  return 'noStrongSignal' in answer
    ? { kind: 'noStrongSignal', reason: answer.reason, model, costUsd }
    : {
        kind: 'pick',
        serviceSlug: answer.serviceSlug,
        reason: answer.reason,
        signalKeys: answer.signalIds,
        model,
        costUsd,
      };
}
