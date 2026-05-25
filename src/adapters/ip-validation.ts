/**
 * @module adapters/ip-validation
 * @description Private/reserved IP address validation for SSRF mitigation (BUG-13).
 *
 * Extracted from rails/review.ts to keep IP-level concerns in the adapters layer.
 */

/** Private/reserved IPv4 CIDR ranges that must be blocked. */
const PRIVATE_IPV4_RANGES: Array<{ prefix: number; mask: number }> = [
  { prefix: 0x7f000000, mask: 0xff000000 }, // 127.0.0.0/8  (loopback)
  { prefix: 0x0a000000, mask: 0xff000000 }, // 10.0.0.0/8   (RFC 1918)
  { prefix: 0xac100000, mask: 0xfff00000 }, // 172.16.0.0/12 (RFC 1918)
  { prefix: 0xc0a80000, mask: 0xffff0000 }, // 192.168.0.0/16 (RFC 1918)
  { prefix: 0xa9fe0000, mask: 0xffff0000 }, // 169.254.0.0/16 (link-local)
  { prefix: 0x00000000, mask: 0xff000000 }, // 0.0.0.0/8      (current network)
  { prefix: 0x64400000, mask: 0xffc00000 }, // 100.64.0.0/10  (CGNAT)
  { prefix: 0xc0000200, mask: 0xffffff00 }, // 192.0.2.0/24   (TEST-NET-1)
  { prefix: 0xc6336400, mask: 0xffffff00 }, // 198.51.100.0/24 (TEST-NET-2)
  { prefix: 0xcb007100, mask: 0xffffff00 }, // 203.0.113.0/24 (TEST-NET-3)
  { prefix: 0xc6120000, mask: 0xfffe0000 }, // 198.18.0.0/15  (benchmarking)
  { prefix: 0xe0000000, mask: 0xf0000000 }, // 224.0.0.0/4    (multicast)
  { prefix: 0xf0000000, mask: 0xf0000000 }, // 240.0.0.0/4    (reserved/future)
  { prefix: 0xffffffff, mask: 0xffffffff }, // 255.255.255.255 (broadcast)
];

/**
 * Parse a dotted-decimal IPv4 string into a 32-bit integer.
 * Returns null if the string is not a valid IPv4 address.
 */
export function parseIPv4(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let result = 0;
  for (const part of parts) {
    // Reject non-decimal input such as hex; preserve existing leading-zero decimal behavior.
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (!Number.isInteger(n) || n < 0 || n > 255) return null;
    result = (result << 8) | n;
  }
  return result >>> 0; // unsigned 32-bit
}

/**
 * Check if an IPv4 address (as 32-bit int) falls within any private/reserved range.
 */
export function isPrivateIPv4(ip: number): boolean {
  return PRIVATE_IPV4_RANGES.some((range) => (ip & range.mask) >>> 0 === range.prefix >>> 0);
}

/**
 * Check if an IPv6 address string is private/reserved.
 * Covers: ::/128, ::1/128, fc00::/7, fe80::/10, ff00::/8, and IPv4-mapped IPv6.
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  const mappedIpv4 = parseIPv4MappedIPv6(normalized);
  if (mappedIpv4 !== null) return isPrivateIPv4(mappedIpv4);
  if (normalized === '::' || normalized === '::1') return true;
  if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  if (/^fe[89ab]/.test(normalized)) return true;
  return normalized.startsWith('ff');
}

function parseIPv4MappedIPv6(ip: string): number | null {
  const prefix = '::ffff:';
  if (!ip.startsWith(prefix)) return null;
  const suffix = ip.slice(prefix.length);
  const dotted = parseIPv4(suffix);
  if (dotted !== null) return dotted;

  const hextets = suffix.split(':');
  if (hextets.length !== 2) return null;
  const high = parseHextet(hextets[0]!);
  const low = parseHextet(hextets[1]!);
  if (high === null || low === null) return null;
  return (((high << 16) >>> 0) | low) >>> 0;
}

function parseHextet(value: string): number | null {
  if (!/^[0-9a-f]{1,4}$/.test(value)) return null;
  const parsed = Number.parseInt(value, 16);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= 0xffff ? parsed : null;
}
