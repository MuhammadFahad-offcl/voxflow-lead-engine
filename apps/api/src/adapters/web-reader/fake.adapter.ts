/**
 * The fake web reader: fictional sites from fixtures/sites instead of the network, read with the
 * same rules as the real adapter.
 *
 * Serves: ADR-0007 (DEMO_MODE binds every fake), FR-36, NFR-9; issue #11.
 * Used by: apps/api/src/bootstrap.ts, through `bindAdapter`, when DEMO_MODE=true; tests.
 */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Injectable } from '@hazeljs/core';
import type { WebReaderPort, WebsiteRead } from '../../ports/web-reader.port.js';
import { readSite, type SiteTransport } from './read-site.js';

const FIXTURES_DIR = resolve(import.meta.dirname, '../../../../../fixtures/sites');

// https://p01.example.com/ → p01.example.com.html; /contact → p01.example.com--contact.html.
// Only letters, digits, dots and dashes reach the file name, so no URL can leave the folder.
const fixtureFile = (url: string, suffix = ''): string => {
  const { hostname, pathname } = new URL(url);
  const parts = [hostname, pathname.split('/').filter(Boolean).join('-'), suffix];
  const name = parts
    .filter(Boolean)
    .join('--')
    .replace(/[^a-z0-9.-]/gi, '-');
  return join(FIXTURES_DIR, `${name}.html`);
};

const fixtures: SiteTransport = {
  // A site or page with no fixture answers 404, as a missing page would.
  get: (url) =>
    readFile(fixtureFile(url), 'utf8').then(
      (body) => ({ url, status: 200, body }),
      () => ({ url, status: 404, body: '' }),
    ),
  // What Lightpanda would show: the `--rendered` fixture when there is one, else the same page.
  render: (url) =>
    readFile(fixtureFile(url, 'rendered'), 'utf8')
      .catch(() => readFile(fixtureFile(url), 'utf8'))
      .then((html) => ({ url, html })),
};

/** Serves fixtures/sites/*.html. */
@Injectable()
export class FakeWebReaderAdapter implements WebReaderPort {
  /** @inheritDoc */
  read(url: string): Promise<WebsiteRead> {
    return readSite(url, fixtures);
  }
}
