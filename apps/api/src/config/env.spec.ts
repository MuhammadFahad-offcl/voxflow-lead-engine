/**
 * Unit tests of the environment schema.
 *
 * Serves: docs/architecture.md §12, NFR-5, issue #6 acceptance criterion 1.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { InvalidEnvError, loadEnv } from './env.js';

const minimal = { DATABASE_URL: 'postgresql://fictional:fictional@localhost:5432/fictional' };

const errorOf = (source: Record<string, string | undefined>): InvalidEnvError => {
  try {
    loadEnv(source);
  } catch (error) {
    if (error instanceof InvalidEnvError) return error;
    throw error;
  }
  throw new Error('loadEnv did not throw');
};

// Proves a bad environment stops startup with variable names only, never values (NFR-5).
describe('loadEnv', () => {
  it('fills defaults so DATABASE_URL alone is a valid demo environment', () => {
    const env = loadEnv(minimal);

    expect(env).toMatchObject({
      DEMO_MODE: true,
      API_HOST: '127.0.0.1',
      API_PORT: 4000,
      LOG_LEVEL: 'info',
    });
  });

  it('treats an empty value, as .env.example leaves keys, as unset', () => {
    expect(loadEnv({ ...minimal, ANTHROPIC_API_KEY: '' }).ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('gives a key with a default its default when the value is empty', () => {
    expect(loadEnv({ ...minimal, API_PORT: '', LOG_LEVEL: '' })).toMatchObject({
      API_PORT: 4000,
      LOG_LEVEL: 'info',
    });
  });

  it('names DATABASE_URL as missing when it is empty', () => {
    expect(errorOf({ DATABASE_URL: '' }).variables).toEqual(['DATABASE_URL (missing)']);
  });

  it('rejects a LOG_LEVEL that would silence the HazelJS logger', () => {
    for (const level of ['fatal', 'trace', 'silent']) {
      expect(errorOf({ ...minimal, LOG_LEVEL: level }).variables).toEqual(['LOG_LEVEL (invalid)']);
    }
  });

  it('reads DEMO_MODE=false as false', () => {
    const live = {
      ...minimal,
      DEMO_MODE: 'false',
      APIFY_TOKEN: 'fictional-token',
      PERPLEXITY_API_KEY: 'fictional-key',
      ANTHROPIC_API_KEY: 'fictional-key',
    };

    expect(loadEnv(live).DEMO_MODE).toBe(false);
  });

  it('names every real adapter key as missing when DEMO_MODE=false', () => {
    expect(errorOf({ ...minimal, DEMO_MODE: 'false' }).variables).toEqual([
      'APIFY_TOKEN (missing)',
      'PERPLEXITY_API_KEY (missing)',
      'ANTHROPIC_API_KEY (missing)',
    ]);
  });

  it('names DATABASE_URL as missing when it is absent', () => {
    expect(errorOf({}).variables).toEqual(['DATABASE_URL (missing)']);
  });

  it('names every invalid variable without printing its value', () => {
    const error = errorOf({
      ...minimal,
      DATABASE_URL: 'not-a-url-secret-value',
      API_PORT: '99999',
      DEMO_MODE: 'yes',
    });

    expect(error.variables).toEqual([
      'DEMO_MODE (invalid)',
      'DATABASE_URL (invalid)',
      'API_PORT (invalid)',
    ]);
    expect(error.message).not.toContain('not-a-url-secret-value');
    expect(error.message).not.toContain('99999');
  });

  it('rejects a founder WhatsApp number that is not E.164 without echoing it', () => {
    const error = errorOf({ ...minimal, FOUNDER_WHATSAPP: '0300 0000000' });

    expect(error.variables).toEqual(['FOUNDER_WHATSAPP (invalid)']);
    expect(error.message).not.toContain('0000000');
  });
});
