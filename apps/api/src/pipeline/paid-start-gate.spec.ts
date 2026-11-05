/**
 * Unit tests of the gate shutdown uses to wait for a paid start and its saved run id.
 *
 * Serves: FR-33, NFR-1, NFR-2; issue #10.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { setTimeout as sleep } from 'node:timers/promises';
import { PaidStartGate } from './paid-start-gate.js';

// Proves shutdown waits for a section in progress, for a bounded time, and lets no new one begin.
describe('PaidStartGate', () => {
  it('runs a section and returns its result', async () => {
    await expect(new PaidStartGate().run(() => Promise.resolve('run-1'))).resolves.toBe('run-1');
  });

  it('passes a section error on, and is free again after it', async () => {
    const gate = new PaidStartGate();

    await expect(gate.run(() => Promise.reject(new Error('fictional')))).rejects.toThrow(
      'fictional',
    );

    await expect(gate.close(1000)).resolves.toBe(true);
  });

  it('refuses a section once closed, without running it', async () => {
    const gate = new PaidStartGate();
    await gate.close(0);
    let ran = false;

    const result = await gate.run(() => {
      ran = true;
      return Promise.resolve();
    });

    expect(result).toBe('CLOSED');
    expect(ran).toBe(false);
  });

  it('closes at once when nothing is running', async () => {
    await expect(new PaidStartGate().close(60_000)).resolves.toBe(true);
  });

  it('waits for the section in progress', async () => {
    const gate = new PaidStartGate();
    const done: string[] = [];
    const section = gate.run(async () => {
      await sleep(50);
      done.push('saved');
    });

    await expect(gate.close(5000)).resolves.toBe(true);

    expect(done).toEqual(['saved']);
    await section;
  });

  it('counts a section that failed as finished', async () => {
    const gate = new PaidStartGate();
    const section = gate.run(async () => {
      await sleep(10);
      throw new Error('fictional');
    });

    await expect(gate.close(5000)).resolves.toBe(true);

    await expect(section).rejects.toThrow('fictional');
  });

  it('gives up after the wait when a section hangs', async () => {
    const gate = new PaidStartGate();
    void gate.run(() => sleep(300));

    await expect(gate.close(20)).resolves.toBe(false);
  });
});
