/**
 * Unit tests of the link check: only http(s) URLs become links, however a script URL is disguised.
 *
 * Serves: NFR-5; T-1 audit.
 * Used by: `pnpm test`, through the `web` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import { safeHref } from './safe-href';

// Proves a source from outside data can never run script in the dashboard.
describe('safeHref', () => {
  it.each([
    'https://maps.example/fictional',
    'http://fictional.example/contact',
    ' https://x.example/ ',
  ])('keeps %j', (url) => {
    expect(safeHref(url)).toBe(new URL(url.trim()).href);
  });

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    ' javascript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///C:/Windows/win.ini',
    '/relative/path',
    'not a url',
  ])('refuses %j', (url) => {
    expect(safeHref(url)).toBeNull();
  });
});
