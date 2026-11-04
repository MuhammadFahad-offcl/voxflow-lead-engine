# 0013. Patch @hazeljs/core: bind to 127.0.0.1 and clear health-check timers

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Muhammad Fahad
- **PRD links:** NFR-5, NFR-8, NFR-10; ADR-0001, ADR-0003

## Context

Two defects in `@hazeljs/core` 2.0.13 (latest on npm and the same on upstream `main`, checked 2026-11-04):

1. **No host for `listen`.** ADR-0003 says everything except the tunnel's three paths binds to 127.0.0.1. `HazelApp.listen(port)` calls Node's `server.listen(port, callback)` with no host, so Node listens on every interface. On shared Wi-Fi, port 4000 would be open to anyone on the network. `HazelAppOptions` has no host setting, and the request handler is built inside `listen()`, so we cannot hand it to our own server.
2. **Health-check timers outlive the check.** `HealthCheckManager.runChecks` races each check against a 5 s `setTimeout` and never clears it. HazelJS registers `memory` and `eventLoop` checks by default, so every `GET /ready` leaves two timers running for 5 s. In tests this kept Jest alive 5 s after the run and printed "Jest did not exit"; in the API it piles up timers on every readiness probe.

## Options considered

1. **One `pnpm patch` fixing both** — true 127.0.0.1 binding with correct types, and timers cleared as soon as a check settles. We carry a small patch until HazelJS ships the fixes.
2. **Work around each in our code** — cast Node's options object into `listen({ port, host } as unknown as number)`, which lies to the type checker and logs `[object Object]`; and hide the timers with Jest `--forceExit`, which also hides our own leaks.
3. **Bind every interface and rely on Windows Firewall; accept the slow exit** — no code. Breaks ADR-0003, depends on laptop settings no test can check, and leaves a misleading warning in every test run.

## Decision

Option 1: `patches/@hazeljs__core@2.0.13.patch`, registered under `patchedDependencies` in `pnpm-workspace.yaml`.

- `listen(port, host?)` passes `host` to `server.listen`, logs the real host and bound port, and prints the LAN "Network" URL only when no host is given.
- `runChecks` clears each check's timeout in a `finally`.

`apps/api/test/server.int.spec.ts` asserts the server address is `127.0.0.1`, and Jest exits without the "did not exit" warning.

## Consequences

- The API listens on 127.0.0.1 only; `netstat` confirmed it during #3. Tests finish in about 2 s instead of 6 s.
- The patch is tied to exactly 2.0.13. Upgrading HazelJS means re-creating the patch or dropping it; pnpm stops the install if it no longer applies.
- Both defects are filed upstream, one issue each (see References).
- Revisit when a HazelJS release fixes both: remove the patch and mark this ADR superseded.

## References

- [hazel-js/hazeljs#35](https://github.com/hazel-js/hazeljs/issues/35) — `HazelApp.listen()` cannot bind to a specific host
- [hazel-js/hazeljs#36](https://github.com/hazel-js/hazeljs/issues/36) — `HealthCheckManager.runChecks` leaves timeout timers running

When HazelJS releases the fixes, remove `patches/@hazeljs__core@2.0.13.patch` and its `patchedDependencies` entry in `pnpm-workspace.yaml`.
