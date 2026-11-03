# 0012. Pin TypeScript 6.0.3 until the lint and test tools support 7

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Muhammad Fahad
- **PRD links:** NFR-8

## Context

NFR-8 needs strict TypeScript, type-aware ESLint and Jest, all green on every merge. The newest TypeScript is 7.0.2 (8 Jul 2026), but the tools that load the compiler do not accept it yet (npm registry, checked 2026-11-04):

| Package                                                                      | Version | Accepts `typescript`          |
| ---------------------------------------------------------------------------- | ------- | ----------------------------- |
| [typescript-eslint](https://www.npmjs.com/package/typescript-eslint)         | 8.72.1  | `>=4.8.4 <6.1.0` (peer)       |
| [eslint-plugin-sonarjs](https://www.npmjs.com/package/eslint-plugin-sonarjs) | 4.2.2   | `>=5 <6.1.0` (dependency)     |
| [ts-jest](https://www.npmjs.com/package/ts-jest)                             | 29.4.15 | `>=4.3 <7` (peer)             |
| [@hazeljs/core](https://www.npmjs.com/package/@hazeljs/core)                 | 2.0.13  | no range; built with `^6.0.3` |

The newest version inside every range is 6.0.3 (16 Apr 2026).

## Options considered

1. **TypeScript 6.0.3, pinned exactly** — every gate runs on a supported combination. We miss TypeScript 7's faster compiler, which matters little at this repo's size.
2. **TypeScript 7.0.2 with peer warnings ignored** — faster `tsc`. The linter and the Jest transformer run outside their supported range, so a strange lint or test failure could be the tooling, not our code.
3. **TypeScript 7 for `tsc`, 6 for ESLint and Jest** — two compilers that can disagree about the same file, and two versions to keep in step.

## Decision

Pin `typescript` to exactly `6.0.3` in the root `package.json`.

## Consequences

- typecheck, lint and test all run on versions their maintainers support.
- A TypeScript bump is its own PR that moves typescript-eslint and ts-jest at the same time.
- Revisit when typescript-eslint and ts-jest both include 7 in their peer range.
