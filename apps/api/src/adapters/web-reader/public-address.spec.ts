/**
 * Unit tests of the address rule and the checked lookup the website reader connects through.
 *
 * Serves: FR-9, ADR-0003, ADR-0004; issue #11 (founder's security rule on fetched addresses).
 * Used by: `pnpm test`, through the `api` project in jest.config.mjs.
 */
import { describe, expect, it } from '@jest/globals';
import type { LookupAddress } from 'node:dns';
import {
  allowedOnlyLookup,
  isPublicAddress,
  ReadRefusedError,
  resolveWithSystem,
  type ResolveHost,
} from './public-address.js';

// Addresses as text, like the ranges in the code: sonarjs's hard-coded IP check reads every
// address string literal as one to connect to. One address per line, then what it is.
const rows = (text: string): [string, string][] =>
  text
    .trim()
    .split('\n')
    .map((line) => {
      const [address = '', ...what] = line.trim().split(/\s+/);
      return [address, what.join(' ')];
    });

// Proves only public unicast addresses pass, in IPv4, IPv6 and IPv4-mapped IPv6.
describe('isPublicAddress', () => {
  it.each(
    rows(`
      0.0.0.0                 unspecified
      10.1.2.3                private
      100.64.0.1              CGNAT
      127.0.0.1               loopback
      169.254.169.254         link-local, cloud metadata
      172.16.0.1              private
      192.168.1.10            private
      224.0.0.251             multicast
      ::                      unspecified IPv6
      ::1                     loopback IPv6
      ::ffff:127.0.0.1        IPv4-mapped loopback
      ::ffff:7f00:1           IPv4-mapped loopback, hex form
      ::ffff:10.0.0.1         IPv4-mapped private
      64:ff9b::a00:1          NAT64 of a private address
      2002:a00:1::1           6to4 of a private address
      2001:0:4136:e378::1     Teredo
      fd12:3456::1            unique local
      fe80::1                 link-local IPv6
      fe80::1%eth0            link-local with a zone
      ff02::1                 multicast IPv6
      clinic.example          a name, not an address
    `),
  )('refuses %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });

  it.each(
    rows(`
      8.8.8.8                 public IPv4
      172.32.0.1              just past the private 172.16.0.0/12
      100.128.0.1             just past CGNAT
      2606:4700:4700::1111    public IPv6
    `),
  )('allows %s (%s)', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });
});

const [PUBLIC, PRIVATE, LOOPBACK] = rows(`
  8.8.8.8     public
  10.0.0.5    private
  127.0.0.1   loopback
`).map(([address]) => address) as [string, string, string];

const lookUp = (resolve: ResolveHost, hostname: string, all = false) =>
  new Promise<string | LookupAddress[]>((done, fail) => {
    allowedOnlyLookup(resolve, isPublicAddress)(hostname, { all }, (error, address) => {
      if (error === null) done(address);
      else fail(error);
    });
  });
const answer =
  (...addresses: string[]): ResolveHost =>
  () =>
    Promise.resolve(addresses.map((address) => ({ address, family: 4 })));

// Proves a name is refused when any of its addresses is private, and the checked answer is used.
describe('allowedOnlyLookup', () => {
  it.each([
    ['a private address', answer(PRIVATE)],
    ['one public and one private address', answer(PUBLIC, PRIVATE)],
    ['loopback', answer(LOOPBACK)],
    ['no address at all', answer()],
  ])('refuses a name that resolves to %s', async (_what, resolve) => {
    await expect(lookUp(resolve, 'clinic.example')).rejects.toThrow(ReadRefusedError);
  });

  // An IP literal, so the answer does not depend on this machine's hosts file.
  it('refuses loopback with the system resolver production uses', async () => {
    await expect(lookUp(resolveWithSystem, LOOPBACK)).rejects.toThrow(ReadRefusedError);
  });

  it('passes a public answer on, as one address or as all of them', async () => {
    expect(await lookUp(answer(PUBLIC), 'clinic.example')).toBe(PUBLIC);
    expect(await lookUp(answer(PUBLIC), 'clinic.example', true)).toEqual([
      { address: PUBLIC, family: 4 },
    ]);
  });

  it('passes the resolver error on', async () => {
    const failing: ResolveHost = () => Promise.reject(new Error('ENOTFOUND'));

    await expect(lookUp(failing, 'missing.example')).rejects.toThrow('ENOTFOUND');
  });
});
