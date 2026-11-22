/**
 * Agent tests of the solution agent with `@hazeljs/testing`: the real HazelJS runtime, agent, tool,
 * gate provider and LlmService, with a scripted LlmPort that replays fictional answers in the
 * recorded format and a fixed catalog search. No network, no database.
 *
 * Serves: FR-17, FR-33 (every agent call capped and recorded per lead), US-5; issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { expect } from '@jest/globals';
import { AgentRuntime, LogLevel } from '@hazeljs/agent';
import { bindAgentSuite, describeAgent, expectTools } from '@hazeljs/testing';
import type { LlmSpend, LlmSpendRepository } from '../db/llm-spend.repository.js';
import { Prisma } from '../generated/prisma/client.js';
import { GATED_RUNTIME_OPTIONS, GatedLlmProvider } from '../llm/gated-llm.provider.js';
import { LlmService, SpendCapReachedError } from '../llm/llm.service.js';
import type { Logger } from '../logging/logger.js';
import type { LlmPort, LlmReply } from '../ports/llm.port.js';
import {
  registerSolutionAgent,
  runSolutionAgent,
  SOLUTION_AGENT,
  type CatalogMatch,
  type SolutionLead,
} from './solution.agent.js';

const LEAD: SolutionLead = {
  organizationId: 'org_voxflow',
  campaignId: 'campaign-1',
  leadId: 'lead-1',
  name: 'Fictional Bright Smile Dental',
  area: 'DHA Phase 5',
  tier: 'WARM',
  score: 62,
  signals: [
    {
      key: 'phone_unanswered_reviews',
      dimension: 'PAIN',
      points: 20,
      evidence: '"Called three times, nobody picked up."',
    },
    { key: 'mobile_number', dimension: 'REACHABILITY', points: 10, evidence: '+92300000xxxx' },
    { key: 'many_reviews', dimension: 'FIT', points: 8, evidence: '120 Google reviews' },
  ],
};

const SERVICES: CatalogMatch[] = [
  'ai-voice-receptionist',
  'missed-call-whatsapp-reply',
  'whatsapp-booking-assistant',
  'appointment-reminders',
  'patient-recall',
].map((slug) => ({ slug, name: slug, problem: `Problem of ${slug}.`, fittingSignals: [] }));

// Fictional answers in the shape `pnpm llm:record` stores; the gate parses `text`.
const reply = (answer: unknown): LlmReply => ({
  text: JSON.stringify(answer),
  usage: { inputTokens: 900, outputTokens: 60 },
  model: 'claude-haiku-5-5',
  stopReason: 'end_turn',
});
const TOOL = reply({ action: 'tool', name: 'searchCatalog', answer: null });
const pick = (signalIds: string[]) =>
  reply({
    action: 'answer',
    name: null,
    answer: {
      serviceSlug: 'ai-voice-receptionist',
      reason: 'Reviews say nobody answers the phone, so every call needs answering.',
      signalIds,
    },
  });
const VALID = pick(['phone_unanswered_reviews', 'mobile_number']);
const INVENTED = pick(['phone_unanswered_reviews', 'invented_signal']);
const BROKEN: LlmReply = { ...reply(null), text: 'not json' };
const WEAK = reply({
  action: 'answer',
  name: null,
  answer: { noStrongSignal: true, reason: 'No review or page shows a pain the catalog fixes.' },
});

// Each scenario is two agent turns per run: the tool choice, then the answer.
const SCENARIOS: Record<string, LlmReply[]> = {
  valid: [TOOL, VALID],
  'invented then valid': [TOOL, INVENTED, TOOL, VALID],
  'invalid twice': [TOOL, INVENTED, TOOL, INVENTED],
  weak: [TOOL, WEAK],
  // Not JSON twice in one turn: the gate gives up (LlmOutputInvalidError), the runner retries.
  'schema broken then valid': [TOOL, BROKEN, BROKEN, TOOL, VALID],
  // The cap refuses before any answer is used.
  'cap reached': [],
  // The model gives up after the failed search; the outage must still fail the run.
  'search fails': [TOOL, WEAK],
};

// A fresh runtime, gate and catalog per case; `run(scenario)` replays that scenario's answers.
const createContext = () => {
  let replies: LlmReply[] = [];
  let scenario = '';
  const spends: LlmSpend[] = [];
  const toolCalls: string[] = [];
  const port: LlmPort = {
    complete: () => {
      const next = replies.shift();
      if (next === undefined) throw new Error('No scripted answer left');
      return Promise.resolve(next);
    },
  };
  const spend = {
    budget: () =>
      Promise.resolve({
        model: 'claude-haiku-5-5',
        capUsd: new Prisma.Decimal(scenario === 'cap reached' ? 0 : 10),
        spentUsd: new Prisma.Decimal(0),
      }),
    record: (row: LlmSpend) => {
      spends.push(row);
      return Promise.resolve();
    },
  } as unknown as LlmSpendRepository;
  const logger = { warn: () => undefined, error: () => undefined } as unknown as Logger;
  const runtime = new AgentRuntime({
    llmProvider: new GatedLlmProvider(new LlmService(spend, port, logger)),
    ...GATED_RUNTIME_OPTIONS,
    logLevel: LogLevel.ERROR,
    enableMetrics: false,
  });
  registerSolutionAgent(runtime, () => {
    toolCalls.push('searchCatalog');
    if (scenario === 'search fails') return Promise.reject(new Error('database is down'));
    return Promise.resolve(SERVICES);
  });
  return {
    agentName: SOLUTION_AGENT,
    run: async (name: string) => {
      scenario = name;
      replies = [...(SCENARIOS[name] ?? [])];
      const started = Date.now();
      const outcome = await runSolutionAgent(runtime, LEAD);
      return {
        output: JSON.stringify(outcome),
        toolCalls,
        durationMs: Date.now() - started,
        costUsd: outcome.costUsd.toNumber(),
        metadata: { outcome, spends, unused: replies.length },
      };
    },
  };
};

type Outcome = Awaited<ReturnType<typeof runSolutionAgent>>;
const details = (metadata: Record<string, unknown> | undefined) =>
  metadata as { outcome: Outcome; spends: LlmSpend[]; unused: number };

// Proves FR-17 end to end through HazelJS: a valid pick, one retry, NEEDS_REVIEW and
// NO_STRONG_SIGNAL, every model call capped and recorded against the lead, and outages surfacing.
const suite = describeAgent('solution agent', ({ test }) => {
  test('picks a retrieved service citing a PAIN signal after one searchCatalog call', async ({
    run,
  }) => {
    const result = await run('valid');
    const { outcome, spends, unused } = details(result.metadata);

    expectTools(result, ['searchCatalog']);
    expect(outcome).toMatchObject({
      kind: 'pick',
      serviceSlug: 'ai-voice-receptionist',
      signalKeys: ['phone_unanswered_reviews', 'mobile_number'],
      model: 'claude-haiku-5-5',
    });
    expect(spends).toHaveLength(2);
    expect(
      spends.every(({ leadId, campaignId }) => leadId === 'lead-1' && campaignId === 'campaign-1'),
    ).toBe(true);
    expect(unused).toBe(0);
  });

  test('retries once with the problems when a signal is invented, then accepts the valid pick', async ({
    run,
  }) => {
    const result = await run('invented then valid');
    const { outcome, spends } = details(result.metadata);

    expectTools(result, ['searchCatalog', 'searchCatalog']);
    expect(outcome).toMatchObject({ kind: 'pick', serviceSlug: 'ai-voice-receptionist' });
    // Both runs' calls are paid and recorded: 4 calls, 4 cost records, all in the outcome's cost.
    expect(spends).toHaveLength(4);
    const recorded = spends.reduce(
      (sum, { amountUsd }) => sum.plus(amountUsd),
      new Prisma.Decimal(0),
    );
    expect(outcome.costUsd.equals(recorded)).toBe(true);
  });

  test('reports needs review after two invalid answers, naming the problem', async ({ run }) => {
    const result = await run('invalid twice');
    const { outcome } = details(result.metadata);

    expect(outcome).toMatchObject({
      kind: 'needsReview',
      problems: [expect.stringContaining('"invented_signal" is not one of this lead’s signals')],
    });
  });

  test('reports no strong signal when the model finds no evidenced pain', async ({ run }) => {
    const result = await run('weak');
    const { outcome } = details(result.metadata);

    expectTools(result, ['searchCatalog']);
    expect(outcome).toMatchObject({ kind: 'noStrongSignal', model: 'claude-haiku-5-5' });
  });

  test('counts an answer that failed the schema twice as invalid and retries the run', async ({
    run,
  }) => {
    const result = await run('schema broken then valid');
    const { outcome, unused } = details(result.metadata);

    expect(outcome).toMatchObject({ kind: 'pick', serviceSlug: 'ai-voice-receptionist' });
    expect(unused).toBe(0);
  });

  test('lets the cap error reach the caller unwrapped, with nothing sent', async ({ run }) => {
    await expect(run('cap reached')).rejects.toBeInstanceOf(SpendCapReachedError);
  });

  test('fails the run when searchCatalog fails, instead of ending as an exit status', async ({
    run,
  }) => {
    await expect(run('search fails')).rejects.toThrow('database is down');
  });
});

bindAgentSuite(suite, createContext);
