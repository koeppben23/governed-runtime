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
  { prefix: 0x00000000, mask: 0xffffffff }, // 0.0.0.0/32    (unspecified)
];

/** Reserved IPv6 addresses that must be blocked. */
const PRIVATE_IPV6_PREFIXES = ['::1', 'fc00:', 'fd', 'fe80:'];

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
 * Covers: ::1 (loopback), fc00::/7 (unique-local), fe80::/10 (link-local).
 */
export function isPrivateIPv6(ip: string): boolean {
  const normalized = ip.toLowerCase();
  return PRIVATE_IPV6_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}
