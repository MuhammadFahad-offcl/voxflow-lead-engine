/**
 * The fake LLM: answers recorded from the real model, replayed from fixtures/llm instead of the
 * network. From #13's gate PR on, the answer goes through the same parsing, cap and cost record
 * as a real one.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake), FR-13, FR-36, NFR-9; issue #13.
 * Used by: apps/api/src/adapters/llm/fake.adapter.spec.ts; bound in apps/api/src/bootstrap.ts
 * together with the real adapter (#13, next PR).
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { Injectable } from '@hazeljs/core';
import { z } from 'zod';
import { LlmError, type LlmPort, type LlmReply, type LlmRequest } from '../../ports/llm.port.js';

const REPO_ROOT = resolve(import.meta.dirname, '../../../../..');

// A broken file reads as "not valid" below, the same as a file of the wrong shape.
const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** One recorded answer, as `pnpm llm:record` writes it. */
const RecordedReply = z.object({
  text: z.string(),
  usage: z.object({
    inputTokens: z.number().int().nonnegative(),
    outputTokens: z.number().int().nonnegative(),
  }),
  model: z.string().min(1),
  stopReason: z.string().min(1),
});

/**
 * Names the fixture file of a request: the task's folder, then a hash of the prompts.
 *
 * Does not hash the model or the token limit: changing a task's model in Settings keeps the demo
 * working on the answers already recorded.
 * @param fixturesDir - The `fixtures/llm` folder.
 * @param request - The request to find an answer for.
 * @returns The absolute path, e.g. `…/fixtures/llm/review-labelling/3f2a….json`.
 */
export function llmFixturePath(
  fixturesDir: string,
  request: Pick<LlmRequest, 'task' | 'system' | 'user'>,
): string {
  // A JSON pair, so "ab" + "c" and "a" + "bc" never collide, whatever characters they hold.
  const hash = createHash('sha256')
    .update(JSON.stringify([request.system, request.user]))
    .digest('hex')
    .slice(0, 16);
  return join(fixturesDir, request.task.toLowerCase().replaceAll('_', '-'), `${hash}.json`);
}

/** Serves fixtures/llm/<task>/<hash>.json. */
@Injectable()
export class FakeLlmAdapter implements LlmPort {
  /** Where the recorded answers live; a spec points it at a temporary folder. */
  protected readonly fixturesDir: string = join(REPO_ROOT, 'fixtures/llm');

  /**
   * Replays the answer recorded for exactly these prompts, with the usage it was billed for.
   * @inheritDoc
   * @throws LlmError (not billed) naming the missing file and how to record it, when no answer was
   * recorded for these prompts, or naming the file when it is not a valid recorded answer.
   */
  async complete(request: LlmRequest): Promise<LlmReply> {
    const path = llmFixturePath(this.fixturesDir, request);
    // Relative to the repo, with forward slashes, so the message reads the same on every OS.
    const shown = relative(REPO_ROOT, path).replaceAll('\\', '/');
    const body = await readFile(path, 'utf8').catch(() => null);
    if (body === null) {
      throw new LlmError(
        `No recorded LLM answer at ${shown}; record it with \`pnpm llm:record\` (needs ANTHROPIC_API_KEY)`,
        false,
      );
    }
    const parsed = RecordedReply.safeParse(parseJson(body));
    if (!parsed.success) throw new LlmError(`Recorded LLM answer at ${shown} is not valid`, false);
    return parsed.data;
  }
}
