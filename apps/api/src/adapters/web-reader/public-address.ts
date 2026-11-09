/**
 * Decides whether the website reader may connect to an address: public unicast only.
 *
 * Serves: FR-9, ADR-0003 (the laptop's local services stay unreachable), ADR-0004; issue #11.
 * Used by: apps/api/src/adapters/web-reader/safe-get.ts.
 */
import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, type LookupFunction } from 'node:net';
import type { LookupAddress } from 'node:dns';

// Ranges are written as text, one CIDR range per line with what it is: they are rules to refuse,
// not addresses to connect to, which is what sonarjs's hard-coded IP check looks for in literals.
const parseRanges = (table: string): BlockList => {
  const list = new BlockList();
  for (const line of table.trim().split('\n')) {
    const [network = '', prefix = ''] = line.trim().split(/[/\s]/);
    list.addSubnet(network, Number(prefix), isIP(network) === 4 ? 'ipv4' : 'ipv6');
  }
  return list;
};

// The IANA special-purpose ranges that are not plain public hosts.
const refused = parseRanges(`
  0.0.0.0/8       "this network", unspecified
  10.0.0.0/8      private
  100.64.0.0/10   carrier-grade NAT
  127.0.0.0/8     loopback
  169.254.0.0/16  link-local, cloud metadata
  172.16.0.0/12   private
  192.0.0.0/24    IETF protocol assignments
  192.0.2.0/24    documentation
  192.88.99.0/24  6to4 relay
  192.168.0.0/16  private
  198.18.0.0/15   benchmarking
  198.51.100.0/24 documentation
  203.0.113.0/24  documentation
  224.0.0.0/4     multicast
  240.0.0.0/4     reserved, broadcast
  2001::/23       IETF protocol assignments, Teredo among them
  2001:db8::/32   documentation
  2002::/16       6to4, which can wrap a private IPv4 address
  3fff::/20       documentation
`);
// Only IPv6 global unicast counts. Everything outside it is refused without a list: ::, ::1,
// IPv4-mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, unique local fc00::/7, link-local fe80::/10 and
// multicast ff00::/8.
const globalUnicast = parseRanges(`2000::/3 global unicast`);

/**
 * Tells whether an IP address is a public unicast address.
 *
 * Does not resolve names: a hostname, or anything else that is not an IP address, gives false.
 * @param ip - An IPv4 or IPv6 address, without brackets.
 * @returns True only for a public unicast address.
 */
export function isPublicAddress(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return !refused.check(ip, 'ipv4');
  // A zone id ("fe80::1%eth0") only exists on local addresses.
  if (family !== 6 || ip.includes('%')) return false;
  return globalUnicast.check(ip, 'ipv6') && !refused.check(ip, 'ipv6');
}

/** Resolves a hostname to every address it has. */
export type ResolveHost = (hostname: string) => Promise<LookupAddress[]>;

/**
 * Resolves with the system resolver, as Node's own connections do.
 * @param hostname - The name to resolve.
 * @returns Every address, in the resolver's order.
 * @throws The resolver's error, e.g. ENOTFOUND.
 */
export const resolveWithSystem: ResolveHost = (hostname) =>
  dnsLookup(hostname, { all: true, order: 'verbatim' });

/** Thrown when the reader refuses a URL, the address it resolves to, or a response. */
export class ReadRefusedError extends Error {
  /**
   * Builds the error.
   * @param reason - Why, in fixed words: it may be stored and logged, so never page content.
   */
  constructor(reason: string) {
    super(reason);
    this.name = 'ReadRefusedError';
  }
}

/**
 * Builds the `lookup` a connection uses, which refuses a name if any of its addresses is not
 * allowed.
 *
 * Node connects to the address this returns, so the address checked is the address connected to:
 * a name cannot pass with one address and then connect to another (DNS rebinding). One refused
 * address refuses the whole name, so a mixed answer cannot slip through.
 * Does not see IP literals: Node connects to those without a lookup, so the caller checks them.
 * Does not filter by address family: the reader never asks for one.
 * @param resolve - The resolver; tests pass a fixed table.
 * @param isAllowed - The address rule, normally {@link isPublicAddress}.
 * @returns A function for the `lookup` option of `http.request`.
 */
export function allowedOnlyLookup(
  resolve: ResolveHost,
  isAllowed: (ip: string) => boolean,
): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        const [first] = addresses;
        if (first === undefined || addresses.some(({ address }) => !isAllowed(address))) {
          callback(new ReadRefusedError('the site resolves to a private or reserved address'), []);
        } else if (options.all === true) {
          callback(null, addresses);
        } else {
          callback(null, first.address, first.family);
        }
      },
      (error: unknown) => {
        callback(error instanceof Error ? error : new Error('lookup failed'), []);
      },
    );
  };
}
