/**
 * The LLM port the recording scripts use: calls the real model and saves each answer where the
 * fake adapter will replay it from. Not used by the app.
 *
 * Serves: FR-36 (demo mode with recorded LLM answers), ADR-0007; issue #13, issue #19.
 * Used by: apps/api/src/llm-record.ts, apps/api/src/llm-record-solution.ts.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { llmFixturePath } from '../adapters/llm/fake.adapter.js';
import type { LlmPort, LlmReply, LlmRequest } from '../ports/llm.port.js';

/** Calls the real model and saves each answer where the fake adapter will look for it. */
export class RecordingLlm implements LlmPort {
  /**
   * Wraps the real adapter.
   * @param real - The Anthropic adapter (or a guard around it).
   * @param fixturesDir - The `fixtures/llm` folder.
   */
  constructor(
    private readonly real: LlmPort,
    private readonly fixturesDir: string,
  ) {}

  /**
   * Sends the request and saves the raw answer and its usage, a bad answer included: the gate's
   * retry prompt differs, so the fake replays the same two steps.
   * @param request - The request.
   * @returns The real answer.
   * @throws Whatever the wrapped port throws; nothing is saved then.
   */
  async complete(request: LlmRequest): Promise<LlmReply> {
    const reply = await this.real.complete(request);
    const path = llmFixturePath(this.fixturesDir, request);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(reply, null, 2)}\n`);
    return reply;
  }
}
