/**
 * Unit test of the test environment helper.
 *
 * Serves: ADR-0007 (tests never call paid services), NFR-5; the #5 carry-over on `.env` in Jest.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { afterEach, describe, expect, it } from '@jest/globals';
import { testEnv } from './test-env.js';

const keys = ['DEMO_MODE', 'ANTHROPIC_API_KEY', 'VAPI_API_KEY', 'LOG_LEVEL'] as const;
const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));

// Proves a live key or DEMO_MODE=false loaded from .env into process.env never reaches a test.
describe('testEnv', () => {
  afterEach(() => {
    for (const key of keys) {
      if (before[key] === undefined) Reflect.deleteProperty(process.env, key);
      else process.env[key] = before[key];
    }
  });

  it('forces demo mode and no service keys whatever process.env holds', () => {
    process.env['DEMO_MODE'] = 'false';
    process.env['ANTHROPIC_API_KEY'] = 'fictional-live-key';
    process.env['VAPI_API_KEY'] = 'fictional-live-key';
    process.env['LOG_LEVEL'] = 'debug';

    const env = testEnv();

    expect(env.DEMO_MODE).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.VAPI_API_KEY).toBeUndefined();
    expect(env.LOG_LEVEL).toBe('error');
  });
});
