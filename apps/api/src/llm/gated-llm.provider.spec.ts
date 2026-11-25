/**
 * Unit tests of the provider that routes HazelJS agent model calls through the LLM gate.
 *
 * Serves: FR-17, FR-33 (every agent call under the monthly cap, with a cost record), ADR-0001,
 * ADR-0006; issue #19.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import type { LLMChatRequest } from '@hazeljs/agent';
import { z } from 'zod';
import { Prisma } from '../generated/prisma/client.js';
import {
  GatedLlmProvider,
  newAgentLlmScope,
  runInAgentLlmScope,
  stopAgentLlmScope,
} from './gated-llm.provider.js';
import type { LlmCall, LlmResult } from './llm.service.js';

const Answer = z.object({ pick: z.string() });

// Stands in for LlmService.complete: records each call and returns the queued data.
const gate = (answers: unknown[]) => {
  const calls: LlmCall<unknown>[] = [];
  return {
    calls,
    complete: <T>(call: LlmCall<T>): Promise<LlmResult<T>> => {
      calls.push(call);
      const data = call.schema.parse(answers.shift());
      return Promise.resolve({
        data,
        costUsd: new Prisma.Decimal('0.00002'),
        model: 'claude-haiku-5-5',
      });
    },
  };
};

const tool = {
  type: 'function' as const,
  function: {
    name: 'searchCatalog',
    description: 'Finds the closest catalog services.',
    parameters: { type: 'object' as const, properties: {}, required: [] },
  },
};
const request = (extra: LLMChatRequest['messages'] = []): LLMChatRequest => ({
  messages: [
    { role: 'system', content: 'Pick one service.' },
    { role: 'user', content: 'Lead: Fictional Clinic' },
    ...extra,
  ],
  tools: [tool],
});
const scope = () =>
  newAgentLlmScope({
    organizationId: 'org_voxflow',
    campaignId: 'c1',
    leadId: 'l1',
    task: 'SOLUTION',
    answer: Answer,
    maxTokens: 800,
  });

// Proves every agent turn becomes one gated call with the lead's ids, and maps both answer kinds.
describe('GatedLlmProvider', () => {
  it('sends one gated call with the scope’s task, ids and token limit, and maps a tool choice to tool_calls', async () => {
    const llm = gate([{ action: 'tool', name: 'searchCatalog', answer: null }]);
    const runScope = scope();

    const response = await runInAgentLlmScope(runScope, () =>
      new GatedLlmProvider(llm).chat(request()),
    );

    expect(response).toEqual({
      content: '',
      tool_calls: [
        { id: 'call_1', type: 'function', function: { name: 'searchCatalog', arguments: '{}' } },
      ],
    });
    expect(llm.calls[0]).toMatchObject({
      organizationId: 'org_voxflow',
      campaignId: 'c1',
      leadId: 'l1',
      task: 'SOLUTION',
      user: 'Lead: Fictional Clinic',
      maxTokens: 800,
    });
    expect(llm.calls[0]?.system).toContain('Pick one service.');
    expect(llm.calls[0]?.system).toContain('searchCatalog: Finds the closest catalog services.');
    expect(runScope.models).toEqual(['claude-haiku-5-5']);
    expect(runScope.costUsd.toString()).toBe('0.00002');
  });

  it('maps a final answer to its JSON content and sends the tool result as part of the user text', async () => {
    const llm = gate([{ action: 'answer', name: null, answer: { pick: 'ai-voice-receptionist' } }]);

    const response = await runInAgentLlmScope(scope(), () =>
      new GatedLlmProvider(llm).chat(
        request([{ role: 'assistant', content: '[Tool result: searchCatalog]\nOutput: []' }]),
      ),
    );

    expect(response).toEqual({ content: '{"pick":"ai-voice-receptionist"}' });
    expect(llm.calls[0]?.user).toBe(
      'Lead: Fictional Clinic\n\n[Tool result: searchCatalog]\nOutput: []',
    );
  });

  // Regression: a union at the top of the schema was refused by the API (HTTP 400) when recording.
  it('sends an answer schema with one object at the top, which the API accepts', async () => {
    const llm = gate([{ action: 'tool', name: 'searchCatalog', answer: null }]);
    await runInAgentLlmScope(scope(), () => new GatedLlmProvider(llm).chat(request()));
    const sent = llm.calls[0]?.schema;
    if (sent === undefined) throw new Error('no call was sent');

    const { schema: json } = zodOutputFormat(sent);

    expect(json).toMatchObject({ type: 'object' });
    expect(json).not.toHaveProperty('anyOf');
    expect(json).not.toHaveProperty('oneOf');
  });

  it.each([
    ['a tool call with no name', { action: 'tool', name: null, answer: null }],
    ['a final answer with no answer', { action: 'answer', name: null, answer: null }],
  ])('rejects %s', async (_what, reply) => {
    const llm = gate([{ action: 'tool', name: 'searchCatalog', answer: null }]);
    await runInAgentLlmScope(scope(), () => new GatedLlmProvider(llm).chat(request()));

    expect(llm.calls[0]?.schema.safeParse(reply).success).toBe(false);
  });

  it('refuses a call made outside a scope, so no agent call can skip the gate', async () => {
    await expect(new GatedLlmProvider(gate([])).chat(request())).rejects.toThrow('outside');
  });

  it('refuses a tool with parameters, which the answer schema cannot express', async () => {
    const withParameters = {
      ...tool,
      function: {
        ...tool.function,
        parameters: { type: 'object' as const, properties: { query: { type: 'string' } } },
      },
    };

    await expect(
      runInAgentLlmScope(scope(), () =>
        new GatedLlmProvider(gate([])).chat({ ...request(), tools: [withParameters] }),
      ),
    ).rejects.toThrow('takes parameters');
  });

  it('sends nothing more once a tool stopped the run, and throws the tool’s error', async () => {
    const llm = gate([{ action: 'tool', name: 'searchCatalog', answer: null }]);
    const refused = new Error('Catalog search failed');

    const second = runInAgentLlmScope(scope(), async () => {
      await new GatedLlmProvider(llm).chat(request());
      stopAgentLlmScope(refused);
      return new GatedLlmProvider(llm).chat(request());
    });

    await expect(second).rejects.toBe(refused);
    expect(llm.calls).toHaveLength(1);
  });

  it('refuses a second call after the gate itself failed, without calling the model again', async () => {
    const capReached = new Error('cap reached');
    let completes = 0;
    const failing = {
      complete: (): Promise<never> => {
        completes += 1;
        return Promise.reject(capReached);
      },
    };

    const second = runInAgentLlmScope(scope(), async () => {
      await new GatedLlmProvider(failing).chat(request()).catch(() => undefined);
      return new GatedLlmProvider(failing).chat(request());
    });

    await expect(second).rejects.toBe(capReached);
    expect(completes).toBe(1);
  });

  it('keeps the first gate error on the scope, so the runner can rethrow it unwrapped', async () => {
    const failing = {
      complete: (): Promise<never> => Promise.reject(new Error('cap reached')),
    };
    const runScope = scope();

    await expect(
      runInAgentLlmScope(runScope, () => new GatedLlmProvider(failing).chat(request())),
    ).rejects.toThrow('cap reached');
    expect(runScope.failure).toBeInstanceOf(Error);
  });
});
