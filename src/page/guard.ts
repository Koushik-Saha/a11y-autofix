/**
 * The SSRF guard for page mode: decides whether a host may be contacted.
 * Loopback, private, link-local, carrier-grade NAT, multicast, reserved
 * and documentation addresses are refused, both as IP literals and as
 * what a hostname resolves to (every address it resolves to must be
 * public). IPv4 embedded in IPv6 (mapped, NAT64, 6to4) is checked as
 * IPv4. A host on the caller's allowlist (e.g. a local dev server) skips
 * the check.
 *
 * The verdict carries the address that was checked, and the egress proxy
 * connects to exactly that address, so a hostname can't pass the check
 * and then re-resolve somewhere private (DNS rebinding).
 */

import { lookup as dnsLookup } from 'node:dns/promises';
import { BlockList, isIP, isIPv4, isIPv6 } from 'node:net';

const BLOCKED_V4: [string, number][] = [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, incl. cloud metadata (169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, incl. broadcast
];
const BLOCKED_V6: [string, number][] = [
  ['::', 128], // unspecified
  ['::1', 128], // loopback
  ['100::', 64], // discard
  ['2001:db8::', 32], // documentation
  ['fc00::', 7], // unique local
  ['fe80::', 10], // link-local
  ['fec0::', 10], // site-local (deprecated)
  ['ff00::', 8], // multicast
];

const blockList = new BlockList();
for (const [address, prefix] of BLOCKED_V4) blockList.addSubnet(address, prefix, 'ipv4');
for (const [address, prefix] of BLOCKED_V6) blockList.addSubnet(address, prefix, 'ipv6');

/** The eight 16-bit groups of an IPv6 address (with any trailing dotted IPv4 converted). */
function ipv6Groups(address: string): number[] {
  let text = address.toLowerCase().split('%')[0]!;
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const [a, b, c, d] = dotted[1]!.split('.').map(Number) as [number, number, number, number];
    text =
      text.slice(0, -dotted[1]!.length) +
      `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = text.split('::') as [string, string | undefined];
  const parse = (part: string | undefined) =>
    part ? part.split(':').map((group) => parseInt(group, 16)) : [];
  const front = parse(head);
  const back = parse(tail);
  return tail === undefined
    ? front
    : [...front, ...Array(8 - front.length - back.length).fill(0), ...back];
}

/** IPv4 carried inside an IPv6 address (mapped ::ffff:0:0/96, NAT64 64:ff9b::/96, 6to4 2002::/16), if any. */
function embeddedIPv4(address: string): string | null {
  const g = ipv6Groups(address);
  const v4 = (high: number, low: number) => `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return v4(g[6]!, g[7]!);
  if (g[0] === 0x64 && g[1] === 0xff9b && g.slice(2, 6).every((x) => x === 0))
    return v4(g[6]!, g[7]!);
  if (g[0] === 0x2002) return v4(g[1]!, g[2]!);
  return null;
}

/** Whether an IP address may not be contacted from a page scan. Non-IP input counts as blocked. */
export function isBlockedAddress(address: string): boolean {
  const bare = address.replace(/^\[|\]$/g, '');
  if (isIPv4(bare)) return blockList.check(bare, 'ipv4');
  if (isIPv6(bare)) {
    const v4 = embeddedIPv4(bare);
    if (v4 !== null) return blockList.check(v4, 'ipv4');
    return blockList.check(bare.split('%')[0]!, 'ipv6');
  }
  return true;
}

export type Verdict =
  { allowed: true; address: string; family: 4 | 6 } | { allowed: false; reason: string };

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

export interface EgressGuardOptions {
  /**
   * Hosts the scan may reach even though they're private, as `host` or
   * `host:port` (e.g. `localhost:3000` for a dev server). Nothing else
   * private is allowed.
   */
  allowHosts?: readonly string[];
  /** DNS resolution; defaults to the system resolver. Injectable for tests. */
  lookup?: Lookup;
}

export interface EgressGuard {
  check(hostname: string, port: number): Promise<Verdict>;
}

function normalizeHost(hostname: string): string {
  return hostname
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
    .toLowerCase();
}

/** `host` or `host:port` (IPv6 in brackets), normalized. */
function parseAllowEntry(entry: string): { host: string; port: number | null } {
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(entry.trim());
  if (!match) throw new Error(`Invalid --allow-host "${entry}": use host or host:port.`);
  return { host: normalizeHost(match[1]!), port: match[2] ? Number(match[2]) : null };
}

export function createEgressGuard(options: EgressGuardOptions = {}): EgressGuard {
  const allowed = (options.allowHosts ?? []).map(parseAllowEntry);
  const lookup: Lookup =
    options.lookup ?? ((hostname) => dnsLookup(hostname, { all: true, verbatim: true }));
  // One resolution per host per scan: every request to a host uses the
  // address that was checked.
  const resolved = new Map<string, Promise<{ address: string; family: number }[]>>();

  return {
    async check(hostname, port) {
      const host = normalizeHost(hostname);
      const isAllowlisted = allowed.some(
        (entry) => entry.host === host && (entry.port === null || entry.port === port),
      );

      if (isIP(host)) {
        const family = isIPv6(host) ? 6 : 4;
        if (!isAllowlisted && isBlockedAddress(host)) {
          return { allowed: false, reason: `${host} is a private, loopback or reserved address` };
        }
        return { allowed: true, address: host, family };
      }
      if (!isAllowlisted && (host === 'localhost' || host.endsWith('.localhost'))) {
        return { allowed: false, reason: `${host} is a loopback hostname` };
      }

      let addresses: { address: string; family: number }[];
      try {
        if (!resolved.has(host)) resolved.set(host, lookup(host));
        addresses = await resolved.get(host)!;
      } catch (error) {
        return {
          allowed: false,
          reason: `${host} could not be resolved (${(error as Error).message})`,
        };
      }
      if (addresses.length === 0)
        return { allowed: false, reason: `${host} did not resolve to any address` };
      if (!isAllowlisted) {
        const blocked = addresses.find((entry) => isBlockedAddress(entry.address));
        if (blocked) {
          return {
            allowed: false,
            reason: `${host} resolves to ${blocked.address}, a private, loopback or reserved address`,
          };
        }
      }
      const first = addresses[0]!;
      return { allowed: true, address: first.address, family: first.family === 6 ? 6 : 4 };
    },
  };
}
