import { isIP } from 'node:net';

/**
 * Address classification for the SSRF guard. An address is "public" only if
 * it is ordinary unicast internet space: everything private, loopback,
 * link-local, multicast, reserved, documentation, shared (CGNAT, where some
 * clouds put metadata services) or unspecified is refused, and IPv6 forms that
 * embed an IPv4 address (mapped, compatible, NAT64, 6to4) are judged by the
 * embedded address.
 */

const V4_BLOCKED: readonly [string, number][] = [
  ['0.0.0.0', 8], // "this network", unspecified
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // shared address space (CGNAT; e.g. Alibaba metadata 100.100.100.200)
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local (cloud metadata 169.254.169.254)
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast (deprecated)
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, broadcast
];

function v4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p) || Number(p) > 255) return null;
    n = n * 256 + Number(p);
  }
  return n;
}

function inV4(n: number, base: string, bits: number): boolean {
  const b = v4ToInt(base)!;
  const size = 2 ** (32 - bits);
  return Math.floor(n / size) === Math.floor(b / size);
}

function publicV4(ip: string): boolean {
  const n = v4ToInt(ip);
  if (n === null) return false;
  return !V4_BLOCKED.some(([base, bits]) => inV4(n, base, bits));
}

/** The eight 16-bit groups of an IPv6 address (zone ID removed), or null if it is not one. */
export function v6Groups(raw: string): number[] | null {
  let ip = raw.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  if (isIP(ip) !== 6) return null;
  // A trailing dotted IPv4 part becomes two groups.
  const dotted = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(ip);
  if (dotted) {
    const n = v4ToInt(dotted[1]!);
    if (n === null) return null;
    ip = ip.slice(0, -dotted[1]!.length) + `${(n >>> 16).toString(16)}:${(n & 0xffff).toString(16)}`;
  }
  const [head, tail] = ip.includes('::') ? ip.split('::') : [ip, undefined];
  const h = head ? head.split(':') : [];
  const t = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - h.length - t.length;
  const groups = [...h, ...Array<string>(fill).fill('0'), ...t].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => g >= 0 && g <= 0xffff) ? groups : null;
}

const v4From = (hi: number, lo: number): string => `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;

function publicV6(raw: string): boolean {
  const g = v6Groups(raw);
  if (!g) return false;
  const zero = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (mapped) and ::a.b.c.d (compatible, also covers :: and ::1).
  if (zero(0, 5) && (g[5] === 0xffff || g[5] === 0)) return publicV4(v4From(g[6]!, g[7]!));
  // 64:ff9b::/96 (NAT64 well-known prefix) embeds an IPv4 address.
  if (g[0] === 0x64 && g[1] === 0xff9b && zero(2, 6)) return publicV4(v4From(g[6]!, g[7]!));
  // 6to4 (2002::/16) embeds an IPv4 address in groups 1-2.
  if (g[0] === 0x2002) return publicV4(v4From(g[1]!, g[2]!));
  // Only global unicast (2000::/3) is public; everything else is reserved, local or multicast.
  if ((g[0]! & 0xe000) !== 0x2000) return false;
  if (g[0] === 0x2001 && g[1]! < 0x200) return false; // 2001::/23 IETF protocol assignments (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0xdb8) return false; // documentation
  if (g[0] === 0x3fff && g[1]! < 0x1000) return false; // 3fff::/20 documentation
  return true;
}

/** True only for ordinary public unicast addresses (IPv4 or IPv6). Anything unparseable is not public. */
export function isPublicAddress(ip: string): boolean {
  const bare = ip.replace(/^\[|\]$/g, '').replace(/%.*$/, '');
  const kind = isIP(bare);
  if (kind === 4) return publicV4(bare);
  if (kind === 6) return publicV6(bare);
  return false;
}
