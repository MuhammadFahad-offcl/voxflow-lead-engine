/**
 * The one place that chooses a real or a fake adapter for a port.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake; business code never checks it), FR-36, NFR-9.
 * Used by: the adapters module, once the first port exists (#10 adds LeadSourcePort).
 */
import type { Container, InjectionToken, Type } from '@hazeljs/core';
import type { Env } from '../config/env.js';

/** The two implementations of one port. */
export interface AdapterPair<T> {
  /** Calls the outside service; needs that service's keys from the environment. */
  real: Type<T>;
  /** Works offline from fictional fixtures; used in demo mode and tests. */
  fake: Type<T>;
}

/**
 * Registers the fake adapter for `token` when `env.DEMO_MODE` is true, otherwise the real one.
 *
 * Does not create the adapter: HazelJS builds it on first resolve, with its own dependencies
 * injected. Does not check that the real adapter's keys are set: `loadEnv` already did.
 * @param container - The HazelJS container to register into.
 * @param env - Parsed configuration; only `DEMO_MODE` is read.
 * @param token - The port's DI token, which business code injects.
 * @param adapters - The real and fake classes for this port.
 */
export function bindAdapter<T>(
  container: Container,
  env: Pick<Env, 'DEMO_MODE'>,
  token: InjectionToken<T>,
  adapters: AdapterPair<T>,
): void {
  container.registerProvider<T>({ token, useClass: env.DEMO_MODE ? adapters.fake : adapters.real });
}
