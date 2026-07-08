/**
 * @module adapters/ip-validation.test
 * @description Tests for IP address format validation — parseIPv4, isIPv4Address,
 *              isIPv6Address, and private/reserved range checks.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — IPv6 matrix covers SSRF fail-closed
 */

import { describe, it, expect } from 'vitest';
import {
  parseIPv4,
  isPrivateIPv4,
  isPrivateIPv6,
  isIPv4Address,
  isIPv6Address,
} from './ip-validation.js';

// ─── parseIPv4 ────────────────────────────────────────────────────────────────

describe('parseIPv4', () => {
  it('parses a standard IPv4 address', () => {
    expect(parseIPv4('192.168.1.1')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
  });

  it('parses loopback', () => {
    expect(parseIPv4('127.0.0.1')).toBe(((127 << 24) | 1) >>> 0);
  });

  it('parses all-zeros', () => {
    expect(parseIPv4('0.0.0.0')).toBe(0);
  });

  it('parses broadcast', () => {
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
  });

  it('parses leading-zero decimal', () => {
    expect(parseIPv4('010.0.0.1')).toBe(((10 << 24) | 1) >>> 0);
  });

  it('rejects hex input', () => {
    expect(parseIPv4('0x7f.0.0.1')).toBeNull();
    expect(parseIPv4('0XAB.0.0.0')).toBeNull();
  });

  it('rejects non-IP strings', () => {
    expect(parseIPv4('not.an.ip')).toBeNull();
    expect(parseIPv4('')).toBeNull();
  });

  it('rejects wrong segment count', () => {
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
  });

  it('rejects out-of-range octets', () => {
    expect(parseIPv4('256.0.0.1')).toBeNull();
    expect(parseIPv4('-1.0.0.0')).toBeNull();
    expect(parseIPv4('1.2.3.999')).toBeNull();
  });
});

// ─── isPrivateIPv4 ────────────────────────────────────────────────────────────

describe('isPrivateIPv4', () => {
  it('detects loopback as private', () => {
    expect(isPrivateIPv4(parseIPv4('127.0.0.1')!)).toBe(true);
  });

  it('detects RFC 1918 as private', () => {
    expect(isPrivateIPv4(parseIPv4('10.0.0.1')!)).toBe(true);
    expect(isPrivateIPv4(parseIPv4('192.168.1.1')!)).toBe(true);
    expect(isPrivateIPv4(parseIPv4('172.16.0.1')!)).toBe(true);
  });

  it('detects link-local as private', () => {
    expect(isPrivateIPv4(parseIPv4('169.254.1.1')!)).toBe(true);
  });

  it('allows public IPv4', () => {
    expect(isPrivateIPv4(parseIPv4('8.8.8.8')!)).toBe(false);
    expect(isPrivateIPv4(parseIPv4('93.184.216.34')!)).toBe(false);
  });
});

// ─── isIPv4Address ────────────────────────────────────────────────────────────

describe('isIPv4Address', () => {
  it('returns true for valid IPv4', () => {
    expect(isIPv4Address('192.168.1.1')).toBe(true);
    expect(isIPv4Address('8.8.8.8')).toBe(true);
    expect(isIPv4Address('0.0.0.0')).toBe(true);
  });

  it('returns false for invalid IPv4', () => {
    expect(isIPv4Address('256.0.0.1')).toBe(false);
    expect(isIPv4Address('not.an.ip')).toBe(false);
    expect(isIPv4Address('')).toBe(false);
  });

  it('returns false for IPv6', () => {
    expect(isIPv4Address('::1')).toBe(false);
    expect(isIPv4Address('2001:db8::1')).toBe(false);
  });
});

// ─── isIPv6Address: HAPPY ─────────────────────────────────────────────────────

describe('isIPv6Address / HAPPY', () => {
  it('accepts loopback ::1', () => {
    expect(isIPv6Address('::1')).toBe(true);
  });

  it('accepts unspecified ::', () => {
    expect(isIPv6Address('::')).toBe(true);
  });

  it('accepts full address', () => {
    expect(isIPv6Address('2001:db8:85a3:0:0:8a2e:370:7334')).toBe(true);
  });

  it('accepts compressed middle', () => {
    expect(isIPv6Address('2001:db8::8a2e:370:7334')).toBe(true);
  });

  it('accepts compressed start', () => {
    expect(isIPv6Address('::1')).toBe(true);
  });

  it('accepts link-local', () => {
    expect(isIPv6Address('fe80::1')).toBe(true);
  });

  it('accepts IPv4-mapped dotted-decimal', () => {
    expect(isIPv6Address('::ffff:192.0.2.128')).toBe(true);
  });

  it('accepts IPv4-mapped hex hextet form', () => {
    expect(isIPv6Address('::ffff:c000:280')).toBe(true);
  });

  it('accepts IPv4-mapped with more than two hextets', () => {
    expect(isIPv6Address('::ffff:0:0:1')).toBe(true);
  });

  it('accepts IPv4-mapped two-hextet form', () => {
    expect(isIPv6Address('::ffff:0:0')).toBe(true);
  });

  it('accepts full 8-hextet form of IPv4-mapped', () => {
    expect(isIPv6Address('0:0:0:0:0:ffff:c000:0280')).toBe(true);
  });

  it('accepts leading :: with 7 explicit hextets', () => {
    expect(isIPv6Address('::1:2:3:4:5:6:7')).toBe(true);
  });

  it('accepts trailing :: with 7 explicit hextets', () => {
    expect(isIPv6Address('1:2:3:4:5:6:7::')).toBe(true);
  });
});

// ─── isIPv6Address: BAD ───────────────────────────────────────────────────────

describe('isIPv6Address / BAD', () => {
  it('rejects triple colon', () => {
    expect(isIPv6Address(':::')).toBe(false);
  });

  it('rejects nested double colon', () => {
    expect(isIPv6Address('2001:db8:::1')).toBe(false);
  });

  it('rejects duplicate double colon', () => {
    expect(isIPv6Address('2001::1::1')).toBe(false);
  });

  it('rejects invalid hex digit', () => {
    expect(isIPv6Address('gggg::1')).toBe(false);
  });

  it('rejects 5-char hextet', () => {
    expect(isIPv6Address('12345::1')).toBe(false);
  });

  it('rejects too many segments', () => {
    expect(isIPv6Address('1:2:3:4:5:6:7:8:9')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(isIPv6Address('')).toBe(false);
  });

  it('rejects whitespace', () => {
    expect(isIPv6Address(' ::1')).toBe(false);
    expect(isIPv6Address('::1 ')).toBe(false);
  });

  it('rejects IPv4', () => {
    expect(isIPv6Address('192.168.1.1')).toBe(false);
  });

  it('rejects garbage', () => {
    expect(isIPv6Address('not an address')).toBe(false);
  });
});

// ─── isIPv6Address: CORNER (SSRF fail-closed) ─────────────────────────────────

describe('isIPv6Address / CORNER', () => {
  it('accepts IPv4-mapped loopback (format only — privacy check is separate)', () => {
    expect(isIPv6Address('::ffff:127.0.0.1')).toBe(true);
  });

  it('accepts generic dotted IPv4 tail outside ::ffff: prefix', () => {
    expect(isIPv6Address('2001:db8::192.0.2.1')).toBe(true);
  });

  it('accepts leading :: with dotted IPv4 tail', () => {
    expect(isIPv6Address('::1:2:3:4:5:192.0.2.1')).toBe(true);
  });

  it('accepts trailing :: with dotted IPv4 tail', () => {
    expect(isIPv6Address('1:2:3:4:5::192.0.2.1')).toBe(true);
  });

  it('rejects malformed IPv4-mapped', () => {
    expect(isIPv6Address('::ffff:999.999.999.999')).toBe(false);
  });

  it('rejects single colon (not IPv6)', () => {
    expect(isIPv6Address(':')).toBe(false);
  });

  it('rejects just colons', () => {
    expect(isIPv6Address('::::')).toBe(false);
  });
});

// ─── isPrivateIPv6 ────────────────────────────────────────────────────────────

describe('isPrivateIPv6', () => {
  it('detects :: as private', () => {
    expect(isPrivateIPv6('::')).toBe(true);
  });

  it('detects ::1 as private', () => {
    expect(isPrivateIPv6('::1')).toBe(true);
  });

  it('detects link-local as private', () => {
    expect(isPrivateIPv6('fe80::1')).toBe(true);
  });

  it('detects ULA as private', () => {
    expect(isPrivateIPv6('fc00::1')).toBe(true);
    expect(isPrivateIPv6('fd00::1')).toBe(true);
  });

  it('detects multicast as private', () => {
    expect(isPrivateIPv6('ff02::1')).toBe(true);
  });

  it('allows global unicast', () => {
    expect(isPrivateIPv6('2001:db8::1')).toBe(false);
    expect(isPrivateIPv6('2a00:1450::1')).toBe(false);
  });
});
