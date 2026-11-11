/**
 * Adapter tests of the fake LLM: it replays the answer recorded for exactly these prompts.
 *
 * Serves: ADR-0007, FR-36; issue #13.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { z } from 'zod';
import { LlmError, type LlmRequest } from '../../ports/llm.port.js';
import { FakeLlmAdapter, llmFixturePath } from './fake.adapter.js';

const request: LlmRequest = {
  task: 'REVIEW_LABELLING',
  model: 'claude-haiku-5-5',
  system: 'Label each review.',
  user: 'Fictional review: nobody picks up the phone',
  schema: z.object({ labels: z.array(z.string()) }),
  maxTokens: 2_000,
};
const recorded = {
  text: '{"labels":["PHONE_UNANSWERED"]}',
  usage: { inputTokens: 812, outputTokens: 34 },
  model: 'claude-haiku-5-5',
  stopReason: 'end_turn',
};

let dir = '';
class InTemp extends FakeLlmAdapter {
  protected override readonly fixturesDir = dir;
}

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'llm-fixtures-'));
  const path = llmFixturePath(dir, request);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(recorded));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

// Proves the fake replays by task and prompts, ignores the model, and says how to record a miss.
describe('FakeLlmAdapter.complete', () => {
  it('replays the recorded answer and usage for the same prompts', async () => {
    await expect(new InTemp().complete(request)).resolves.toEqual(recorded);
  });

  it('finds the same answer after the task model changes in Settings', async () => {
    await expect(
      new InTemp().complete({ ...request, model: 'claude-sonnet-5-5' }),
    ).resolves.toEqual(recorded);
  });

  it('files answers by task, in a folder per task', () => {
    expect(llmFixturePath('/f', request).replaceAll('\\', '/')).toMatch(
      /^\/f\/review-labelling\/[0-9a-f]{16}\.json$/,
    );
  });

  it('turns a broken recording into an unbilled LlmError naming the file', async () => {
    const broken = { ...request, user: 'Fictional review with a broken recording' };
    const path = llmFixturePath(dir, broken);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, '{"text": "cut short');

    const error = await new InTemp().complete(broken).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      maybeBilled: false,
      message: expect.stringContaining('is not valid'),
    });
  });

  it('refuses other prompts with an unbilled error that says how to record them', async () => {
    const error = await new InTemp()
      .complete({ ...request, user: 'Another fictional review' })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({
      maybeBilled: false,
      message: expect.stringContaining('pnpm llm:record'),
    });
  });
});
