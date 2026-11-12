/**
 * Structural tests of the dashboard's safety boundaries, read from the source: no client component
 * can reach the server-side API client, and every way of running the dashboard binds to 127.0.0.1.
 *
 * Serves: ADR-0003 (the API and dashboard stay on this machine; the browser never calls the API),
 * NFR-5; T-1 audit.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

const WEB = resolve(import.meta.dirname, '..');
const API_CLIENT = join(WEB, 'lib', 'api.ts');

/**
 * Lists the dashboard's TypeScript sources, tests left out.
 * @param dir - Folder to walk.
 * @returns Absolute paths.
 */
const sources = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'node_modules' || name.startsWith('.')) return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.tsx?$/.test(name) && !/\.spec\.tsx?$/.test(name) ? [path] : [];
  });

/**
 * The project files one file imports with a relative path.
 * @param file - Absolute path of a source file.
 * @returns Absolute paths of the imported files that exist.
 */
const imports = (file: string): string[] =>
  [...readFileSync(file, 'utf8').matchAll(/from '(\.{1,2}\/[^']+)'/g)].flatMap(([, spec]) => {
    const base = resolve(dirname(file), spec ?? '');
    return ['.ts', '.tsx', '/index.ts'].map((ext) => base + ext).filter((path) => existsSync(path));
  });

// Proves ADR-0003 in the code's shape: the server-only API client never lands in a browser bundle.
describe('client components', () => {
  it('never import lib/api.ts, directly or through another file (Server Actions excepted)', () => {
    const clients = sources(WEB).filter((file) =>
      /^'use client';/m.test(readFileSync(file, 'utf8')),
    );
    const reached = new Map<string, string>();
    const queue = clients.map((file) => [file, relative(WEB, file)] as const);
    for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
      const [file, path] = next;
      for (const target of imports(file)) {
        // A 'use server' module reaches the browser only as a call reference, never as code.
        if (reached.has(target) || /^'use server';/m.test(readFileSync(target, 'utf8'))) continue;
        reached.set(target, `${path} → ${relative(WEB, target)}`);
        queue.push([target, reached.get(target) ?? '']);
      }
    }

    expect(clients.length).toBeGreaterThan(0);
    expect(reached.get(API_CLIENT)).toBeUndefined();
  });
});

// Proves ADR-0003 for the dashboard itself: development and production both listen on loopback.
describe('dashboard scripts', () => {
  it('bind `next dev` and `next start` to 127.0.0.1', () => {
    const { scripts } = JSON.parse(readFileSync(join(WEB, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };

    for (const name of ['dev', 'start']) {
      expect({ name, script: scripts[name] }).toEqual({
        name,
        script: expect.stringContaining('--hostname 127.0.0.1'),
      });
    }
  });
});
