/**
 * Unit tests of adapter selection by DEMO_MODE.
 *
 * Serves: ADR-0007, FR-36, issue #6 acceptance criteria 2 and 3.
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { Container, Injectable } from '@hazeljs/core';
import { bindAdapter } from './bind.js';

// Dummy port and adapters, only for this spec: no real port exists yet.
interface GreeterPort {
  greet(): string;
}
const GREETER = 'GreeterPort';

@Injectable()
class RealGreeter implements GreeterPort {
  greet(): string {
    return 'real';
  }
}

@Injectable()
class FakeGreeter implements GreeterPort {
  greet(): string {
    return 'fake';
  }
}

const resolveWith = (demoMode: boolean): GreeterPort => {
  const container = Container.createTestInstance();
  bindAdapter<GreeterPort>(container, { DEMO_MODE: demoMode }, GREETER, {
    real: RealGreeter,
    fake: FakeGreeter,
  });
  return container.resolve<GreeterPort>(GREETER);
};

// Proves DEMO_MODE alone decides which adapter a port resolves to (ADR-0007).
describe('bindAdapter', () => {
  it('binds the fake adapter when DEMO_MODE is true', () => {
    const adapter = resolveWith(true);

    expect(adapter).toBeInstanceOf(FakeGreeter);
    expect(adapter.greet()).toBe('fake');
  });

  it('binds the real adapter when DEMO_MODE is false', () => {
    const adapter = resolveWith(false);

    expect(adapter).toBeInstanceOf(RealGreeter);
    expect(adapter.greet()).toBe('real');
  });
});
