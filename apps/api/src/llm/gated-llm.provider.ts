/**
 * The HazelJS `LLMProvider` for our agents: every model call an agent makes goes through
 * `LlmService` (monthly cap, cost record, schema check, demo-mode replay), never around it.
 *
 * `LlmService` sends one system and one user text with an answer schema, so a tool call is asked
 * for in that schema: `{ action: "tool", name }` or `{ action: "answer", answer }`. HazelJS sees
 * ordinary `tool_calls` and runs the real `@Tool`. The lead, campaign, task and answer schema come
 * from an AsyncLocalStorage scope the caller opens around `AgentRuntime.execute`, because a
 * HazelJS chat request carries no metadata.
 *
 * Serves: FR-17, FR-33 and NFR-4 (cap and cost per lead), ADR-0001, ADR-0006, ADR-0007; issue #19.
 * Used by: apps/api/src/agents/solution.agent.ts, apps/api/src/pipeline/lead.graph.ts (#19 part 2).
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { LLMChatRequest, LLMChatResponse, LLMProvider } from '@hazeljs/agent';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import type { LlmTask } from '../ports/llm.port.js';
import type { LlmService } from './llm.service.js';

/** One agent run's gate settings, plus what the provider learns while it runs. */
export interface AgentLlmScope {
  organizationId: string;
  /** Stored on each cost record, like a step's own LLM call. */
  campaignId: string | null;
  leadId: string | null;
  /** Picks the model from `Settings.llmModels` and names the fixture folder in demo mode. */
  task: LlmTask;
  /** The shape of the agent's final answer. */
  answer: z.ZodType;
  /** The most tokens one model answer may use. */
  maxTokens: number;
  /** Filled in: the model of each call made in this scope. */
  models: string[];
  /** Filled in: what the calls cost together, in US dollars. */
  costUsd: Prisma.Decimal;
  /** Filled in: the first error the gate threw (HazelJS wraps it), or null. */
  failure: unknown;
}

/**
 * `AgentRuntime` settings for any runtime that uses {@link GatedLlmProvider}.
 *
 * HazelJS's defaults re-run a whole failed agent up to 3 times and block every agent for 30 s
 * after 5 failures. Our steps decide retries themselves (FR-17: once, then NEEDS_REVIEW), and a
 * re-run after a billed failure would pay again, so both are off.
 */
export const GATED_RUNTIME_OPTIONS = { enableRetry: false, enableCircuitBreaker: false } as const;

const storage = new AsyncLocalStorage<AgentLlmScope>();

// What the gate's answer schema allows: a tool to call, or the final answer.
type GateAnswer = { action: 'tool'; name: string } | { action: 'answer'; answer: unknown };

/**
 * Builds a fresh scope for one agent run.
 * @param settings - The ids the cost belongs to, the task, the answer schema and the token limit.
 * @returns A scope with no calls made yet.
 */
export const newAgentLlmScope = (
  settings: Omit<AgentLlmScope, 'models' | 'costUsd' | 'failure'>,
): AgentLlmScope => ({ ...settings, models: [], costUsd: new Prisma.Decimal(0), failure: null });

/**
 * Runs `fn` with `scope` as the current agent LLM scope, including everything it awaits.
 * @param scope - From {@link newAgentLlmScope}.
 * @param fn - Usually a call to `AgentRuntime.execute`.
 * @returns What `fn` returns.
 */
export const runInAgentLlmScope = <T>(scope: AgentLlmScope, fn: () => Promise<T>): Promise<T> =>
  storage.run(scope, fn);

// Appended to the agent's system prompt: how to call a tool or answer in one JSON object.
const howToAnswer = (tools: NonNullable<LLMChatRequest['tools']>): string =>
  [
    '## How to answer',
    'Answer with one JSON object and nothing else.',
    ...(tools.length === 0
      ? []
      : [
          'To call a tool, answer {"action": "tool", "name": "<tool name>"}. Tools:',
          ...tools.map(({ function: tool }) => `- ${tool.name}: ${tool.description}`),
        ]),
    'To give your final answer, answer {"action": "answer", "answer": <your answer>}.',
  ].join('\n');

/** Sends each agent turn through the LLM gate. */
export class GatedLlmProvider implements LLMProvider {
  /**
   * Wires the provider to the gate.
   * @param llm - The LLM gate, or anything with its `complete` (tests).
   */
  constructor(private readonly llm: Pick<LlmService, 'complete'>) {}

  /**
   * Sends one agent turn as one gated call and maps the answer back for HazelJS.
   *
   * The system message plus how to answer becomes the system text; the other messages (the input,
   * then HazelJS's "[Tool result: …]" notes) become the user text, in order.
   * Does not support tools with parameters: none of our tools take any.
   * @param request - The messages and tools HazelJS sends.
   * @returns `tool_calls` with one call, or the final answer as JSON text.
   * @throws Error when called outside {@link runInAgentLlmScope} or for a tool with parameters,
   * before anything is sent; whatever `LlmService.complete` throws (cap reached, invalid twice, LLM
   * error), also kept on the scope.
   */
  async chat(request: LLMChatRequest): Promise<LLMChatResponse> {
    const scope = storage.getStore();
    if (scope === undefined) {
      throw new Error('Agent LLM call outside an agent LLM scope: refused, it would skip the cap');
    }
    const tools = request.tools ?? [];
    const withParameters = tools.find(
      ({ function: tool }) => Object.keys(tool.parameters.properties).length > 0,
    );
    if (withParameters !== undefined) {
      throw new Error(`Tool ${withParameters.function.name} takes parameters; not supported`);
    }
    const answer = z.object({ action: z.literal('answer'), answer: scope.answer });
    const toolNames = tools.map(({ function: tool }) => tool.name);
    // Typed by hand: the union of two schema types would otherwise infer as unknown.
    const schema: z.ZodType<GateAnswer> =
      toolNames.length === 0
        ? answer
        : z.discriminatedUnion('action', [
            z.object({ action: z.literal('tool'), name: z.enum(toolNames) }),
            answer,
          ]);
    const system = request.messages.filter(({ role }) => role === 'system');
    const turns = request.messages.filter(({ role }) => role !== 'system');
    try {
      const { data, costUsd, model } = await this.llm.complete({
        organizationId: scope.organizationId,
        campaignId: scope.campaignId,
        leadId: scope.leadId,
        task: scope.task,
        system: [...system.map(({ content }) => content), howToAnswer(tools)].join('\n\n'),
        user: turns.map(({ content }) => content).join('\n\n'),
        schema,
        maxTokens: scope.maxTokens,
      });
      scope.models.push(model);
      scope.costUsd = scope.costUsd.plus(costUsd);
      if (data.action === 'answer') return { content: JSON.stringify(data.answer) };
      const id = `call_${String(scope.models.length)}`;
      return {
        content: '',
        tool_calls: [{ id, type: 'function', function: { name: data.name, arguments: '{}' } }],
      };
    } catch (error) {
      scope.failure ??= error;
      throw error;
    }
  }
}
