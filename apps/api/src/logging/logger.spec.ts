/**
 * Unit tests of the logger's line format, level and child IDs.
 *
 * Serves: NFR-10, ADR-0014.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { DestinationStream } from 'pino';
import { childLogger, createLogger } from './logger.js';

const capture = (): { stream: DestinationStream; lines: () => Record<string, unknown>[] } => {
  const written: string[] = [];
  return {
    stream: { write: (line: string) => written.push(line) },
    lines: () => written.map((line) => JSON.parse(line) as Record<string, unknown>),
  };
};

// Proves every line is one JSON object with a word level, ISO time and the campaign/lead/attempt IDs.
describe('createLogger', () => {
  it('writes one JSON object per line with a word level and an ISO UTC time', () => {
    const { stream, lines } = capture();

    createLogger('info', stream).info('worker started');

    expect(lines()).toEqual([
      expect.objectContaining({
        level: 'info',
        time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
        msg: 'worker started',
      }),
    ]);
  });

  it('drops lines below LOG_LEVEL', () => {
    const { stream, lines } = capture();
    const logger = createLogger('warn', stream);

    logger.info('hidden');
    logger.warn('shown');

    expect(lines().map((line) => line['msg'])).toEqual(['shown']);
  });

  it('adds campaignId, leadId and attemptId through childLogger', () => {
    const { stream, lines } = capture();
    const root = createLogger('info', stream);

    childLogger(root, { campaignId: 'c-fictional', leadId: 'l-fictional', attemptId: 'a-1' }).info(
      'scored',
    );

    expect(lines()[0]).toMatchObject({
      campaignId: 'c-fictional',
      leadId: 'l-fictional',
      attemptId: 'a-1',
      msg: 'scored',
    });
  });
});
