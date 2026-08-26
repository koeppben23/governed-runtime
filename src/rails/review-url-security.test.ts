/**
 * @module review-url-security.test
 * @description Tests for URL validation security boundaries — SSRF mitigation
 *              (BUG-13), DNS resolution validation (Issue #310), and IPv4
 *              parsing (parseIPv4).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import { Readable } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { request } from 'node:https';
import {
  executeReview,
  validateReviewUrl,
  validateResolvedReviewUrlTarget,
  parseIPv4,
} from './review.js';
import { fetchUrlContent, MAX_REVIEW_URL_RESPONSE_BYTES } from './review-url.js';
import { makeState, makeProgressedState } from '../fixtures.js';

vi.mock('node:https', () => ({ request: vi.fn() }));

// ─── Test Helpers ─────────────────────────────────────────────────────────────

const NOW = '2026-01-15T10:00:00.000Z';

// =============================================================================
// BUG-13: URL Validation (SSRF Mitigation)
// =============================================================================

describe('BUG-13: validateReviewUrl — SSRF mitigation', () => {
  // --- HAPPY: valid HTTPS URLs accepted --------------------------------

  describe('HAPPY: valid HTTPS URLs accepted', () => {
    it('accepts standard HTTPS URL', () => {
      const result = validateReviewUrl('https://example.com/spec.md');
      expect(result.valid).toBe(true);
    });

    it('accepts HTTPS URL with port', () => {
      const result = validateReviewUrl('https://api.example.com:8443/data');
      expect(result.valid).toBe(true);
    });

    it('accepts HTTPS URL with path, query, and fragment', () => {
      const result = validateReviewUrl('https://github.com/owner/repo/pull/123.diff?w=1#changes');
      expect(result.valid).toBe(true);
    });
  });

  // --- BAD: disallowed schemes blocked ----------------------------------

  describe('BAD: disallowed schemes blocked', () => {
    it('rejects HTTP URL', () => {
      const result = validateReviewUrl('http://example.com/data');
      expect(result.valid).toBe(false);
      expect(result).toHaveProperty('reason');
      expect((result as { reason: string }).reason).toContain('https:');
    });

    it('rejects file:// URL', () => {
      const result = validateReviewUrl('file:///etc/passwd');
      expect(result.valid).toBe(false);
      expect((result as { reason: string }).reason).toContain('not allowed');
    });

    it('rejects ftp:// URL', () => {
      const result = validateReviewUrl('ftp://server.internal/secret');
      expect(result.valid).toBe(false);
    });

    it('rejects data: URL', () => {
      const result = validateReviewUrl('data:text/plain,hello');
      expect(result.valid).toBe(false);
    });

    it('rejects javascript: URL', () => {
      const result = validateReviewUrl('javascript:alert(1)');
      expect(result.valid).toBe(false);
    });
  });

  // --- BAD: private/reserved IPs blocked --------------------------------

  describe('BAD: private/reserved IP addresses blocked', () => {
    it('rejects localhost', () => {
      const result = validateReviewUrl('https://localhost/admin');
      expect(result.valid).toBe(false);
      expect((result as { reason: string }).reason).toContain('localhost');
    });

    it('rejects 127.0.0.1 (loopback)', () => {
      const result = validateReviewUrl('https://127.0.0.1/internal');
      expect(result.valid).toBe(false);
      expect((result as { reason: string }).reason).toContain('private');
    });

    it('rejects 10.0.0.1 (RFC 1918)', () => {
      const result = validateReviewUrl('https://10.0.0.1/config');
      expect(result.valid).toBe(false);
    });

    it('rejects 172.16.0.1 (RFC 1918)', () => {
      const result = validateReviewUrl('https://172.16.0.1/secrets');
      expect(result.valid).toBe(false);
    });

    it('rejects 192.168.1.1 (RFC 1918)', () => {
      const result = validateReviewUrl('https://192.168.1.1/router');
      expect(result.valid).toBe(false);
    });

    it('rejects 169.254.169.254 (link-local / cloud metadata)', () => {
      const result = validateReviewUrl('https://169.254.169.254/latest/meta-data');
      expect(result.valid).toBe(false);
    });

    it('rejects 0.0.0.0 (unspecified)', () => {
      const result = validateReviewUrl('https://0.0.0.0/');
      expect(result.valid).toBe(false);
    });

    it('rejects IPv6 loopback [::1]', () => {
      const result = validateReviewUrl('https://[::1]/secret');
      expect(result.valid).toBe(false);
      expect((result as { reason: string }).reason).toContain('IPv6');
    });

    it('rejects IPv6 unique-local [fc00::1]', () => {
      const result = validateReviewUrl('https://[fc00::1]/');
      expect(result.valid).toBe(false);
    });

    it('rejects IPv6 link-local [fe80::1]', () => {
      const result = validateReviewUrl('https://[fe80::1]/');
      expect(result.valid).toBe(false);
    });
  });

  // --- CORNER: malformed / edge-case URLs --------------------------------

  describe('CORNER: malformed and edge-case URLs', () => {
    it('rejects empty string', () => {
      const result = validateReviewUrl('');
      expect(result.valid).toBe(false);
      expect((result as { reason: string }).reason).toContain('parsing failed');
    });

    it('rejects string without scheme', () => {
      const result = validateReviewUrl('example.com/path');
      expect(result.valid).toBe(false);
    });

    it('rejects relative path', () => {
      const result = validateReviewUrl('/etc/passwd');
      expect(result.valid).toBe(false);
    });
  });

  // --- EDGE: boundary IPs outside private ranges -------------------------

  describe('EDGE: public IPs accepted', () => {
    it('accepts public IPv4 (8.8.8.8)', () => {
      const result = validateReviewUrl('https://8.8.8.8/dns');
      expect(result.valid).toBe(true);
    });

    it('accepts 172.15.255.255 (just below 172.16/12 range)', () => {
      const result = validateReviewUrl('https://172.15.255.255/ok');
      expect(result.valid).toBe(true);
    });

    it('accepts 172.32.0.0 (just above 172.31/12 range)', () => {
      const result = validateReviewUrl('https://172.32.0.0/ok');
      expect(result.valid).toBe(true);
    });
  });
});

describe('Issue #310: resolved URL targets are validated before fetch', () => {
  function response(body: Uint8Array, headers: Record<string, string> = {}) {
    return Object.assign(Readable.from([body]), {
      statusCode: 200,
      statusMessage: 'OK',
      headers,
    });
  }

  it.each([
    ['malformed UTF-8 bytes', new Uint8Array([0xc3, 0x28]), 'text/plain; charset=utf-8'],
    [
      'unsupported charset',
      new TextEncoder().encode('review material'),
      'text/plain; charset=iso-8859-1',
    ],
    [
      'malformed charset declaration',
      new TextEncoder().encode('review material'),
      'text/plain; charset=',
    ],
  ])('blocks URL materialization with %s', async (_case, body, contentType) => {
    const result = await fetchUrlContent(
      'https://example.com/spec.md',
      async () => [{ address: '93.184.216.34', family: 4 }],
      async () => response(body, { 'content-type': contentType }) as never,
    );
    expect(result).toMatchObject({ kind: 'blocked', code: 'REVIEW_URL_CONTENT_ENCODING_INVALID' });
  });

  it('blocks a compressed response whose decoded material exceeds the limit', async () => {
    const result = await fetchUrlContent(
      'https://example.com/spec.md',
      async () => [{ address: '93.184.216.34', family: 4 }],
      async () =>
        response(gzipSync(Buffer.alloc(MAX_REVIEW_URL_RESPONSE_BYTES + 1, 'x')), {
          'content-encoding': 'gzip',
        }) as never,
    );
    expect(result).toMatchObject({ kind: 'blocked', code: 'COMMAND_BLOCKED' });
  });

  it('accepts hostname DNS results when every resolved address is public', async () => {
    const result = await validateResolvedReviewUrlTarget(
      'https://example.com/spec.md',
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
    );

    expect(result.valid).toBe(true);
  });

  it('binds the fetch transport to the selected validated DNS address', async () => {
    let targetAddress: string | undefined;
    const result = await fetchUrlContent(
      'https://example.com/spec.md',
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      ],
      async (_url, target) => {
        targetAddress = target.address;
        return response(new TextEncoder().encode('review material')) as never;
      },
    );

    expect(result).toEqual({ content: 'review material' });
    expect(targetAddress).toBe('93.184.216.34');
  });

  it('disables Node auto-family selection while the default transport pins DNS', async () => {
    let options: Record<string, unknown> | undefined;
    vi.mocked(request).mockImplementationOnce((_url, requestOptions) => {
      options = requestOptions as Record<string, unknown>;
      const fakeRequest = new EventEmitter() as EventEmitter & {
        setTimeout: () => void;
        destroy: () => void;
        end: () => void;
      };
      fakeRequest.setTimeout = () => undefined;
      fakeRequest.destroy = () => undefined;
      fakeRequest.end = () =>
        queueMicrotask(() => fakeRequest.emit('error', new Error('test transport')));
      return fakeRequest as never;
    });

    const result = await fetchUrlContent('https://example.com/spec.md', async () => [
      { address: '93.184.216.34', family: 4 },
    ]);

    expect(result).toMatchObject({ kind: 'blocked', code: 'COMMAND_BLOCKED' });
    expect(options).toMatchObject({
      autoSelectFamily: false,
      family: 4,
      servername: 'example.com',
    });
    const lookup = options?.lookup;
    expect(lookup).toEqual(expect.any(Function));
    (
      lookup as (
        hostname: string,
        options: unknown,
        callback: (error: NodeJS.ErrnoException | null, address: string, family: 4 | 6) => void,
      ) => void
    )('example.com', { all: false }, (error, address, family) => {
      expect(error).toBeNull();
      expect(address).toBe('93.184.216.34');
      expect(family).toBe(4);
    });
  });

  it('blocks mixed DNS results when any resolved address is private', async () => {
    const result = await validateResolvedReviewUrlTarget(
      'https://example.com/spec.md',
      async () => [
        { address: '93.184.216.34', family: 4 },
        { address: '10.0.0.7', family: 4 },
      ],
    );

    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toContain('private/reserved IPv4');
  });

  it('blocks DNS lookup failures fail-closed', async () => {
    const result = await validateResolvedReviewUrlTarget(
      'https://example.com/spec.md',
      async () => {
        throw new Error('resolver unavailable');
      },
    );

    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toContain('DNS lookup failed');
  });

  it('blocks DNS lookups that return no addresses', async () => {
    const result = await validateResolvedReviewUrlTarget(
      'https://example.com/spec.md',
      async () => [],
    );

    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toContain('returned no addresses');
  });

  it('blocks malformed IPv6 DNS answers fail-closed', async () => {
    const result = await validateResolvedReviewUrlTarget(
      'https://example.com/spec.md',
      async () => [{ address: 'not:ipv6', family: 6 }],
    );

    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toContain('malformed IPv6');
  });

  it.each([
    ['127.0.0.1', 4, 'private/reserved IPv4'],
    ['10.0.0.1', 4, 'private/reserved IPv4'],
    ['172.16.0.1', 4, 'private/reserved IPv4'],
    ['192.168.1.1', 4, 'private/reserved IPv4'],
    ['169.254.169.254', 4, 'private/reserved IPv4'],
    ['100.64.0.1', 4, 'private/reserved IPv4'],
    ['198.18.0.1', 4, 'private/reserved IPv4'],
    ['::1', 6, 'private/reserved IPv6'],
    ['fc00::1', 6, 'private/reserved IPv6'],
    ['fe80::1', 6, 'private/reserved IPv6'],
    ['::ffff:127.0.0.1', 6, 'private/reserved IPv6'],
    ['0:0:0:0:0:ffff:7f00:1', 6, 'private/reserved IPv6'],
    ['::127.0.0.1', 6, 'private/reserved IPv6'],
  ] as const)('blocks private/reserved DNS answer %s', async (address, family, reason) => {
    const result = await validateResolvedReviewUrlTarget(
      'https://example.com/spec.md',
      async () => [{ address, family }],
    );

    expect(result.valid).toBe(false);
    expect((result as { reason: string }).reason).toContain(reason);
  });

  it('blocks expanded IPv4 and IPv6 reserved ranges', async () => {
    const blockedUrls = [
      'https://100.64.0.1/',
      'https://198.18.0.1/',
      'https://192.0.2.1/',
      'https://203.0.113.1/',
      'https://224.0.0.1/',
      'https://240.0.0.1/',
      'https://255.255.255.255/',
      'https://[::]/',
      'https://[ff00::1]/',
      'https://[::ffff:127.0.0.1]/',
    ];

    for (const url of blockedUrls) {
      const result = validateReviewUrl(url);
      expect(result.valid, url).toBe(false);
    }
  });

  it('executeReview blocks a private resolved URL before fetch is called', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    try {
      const state = makeProgressedState('COMPLETE');

      const result = await executeReview(
        state,
        NOW,
        { dnsLookup: async () => [{ address: '127.0.0.1', family: 4 }] },
        { inputOrigin: 'external_reference', url: 'https://metadata.example/spec.md' },
      );

      expect('kind' in result).toBe(true);
      if ('kind' in result && result.kind === 'blocked') {
        expect(result.kind).toBe('blocked');
        expect(result.code).toBe('COMMAND_BLOCKED');
        expect(result.reason).toContain('private/reserved IPv4');
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('blocks an identity response whose body exceeds the decoded limit', async () => {
    const result = await fetchUrlContent(
      'https://example.com/spec.md',
      async () => [{ address: '93.184.216.34', family: 4 }],
      async () => response(Buffer.alloc(MAX_REVIEW_URL_RESPONSE_BYTES + 1, 'x')) as never,
    );
    expect(result).toMatchObject({ kind: 'blocked', code: 'COMMAND_BLOCKED' });
  });
});

// ─── parseIPv4: decimal-only validation (H9) ─────────────────

describe('parseIPv4', () => {
  it('HAPPY: accepts standard IPv4 addresses', () => {
    expect(parseIPv4('192.168.1.1')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
    expect(parseIPv4('127.0.0.1')).toBe(((127 << 24) | (0 << 16) | (0 << 8) | 1) >>> 0);
    expect(parseIPv4('255.255.255.255')).toBe(0xffffffff);
    expect(parseIPv4('0.0.0.0')).toBe(0);
  });

  it('BAD: rejects hex-formatted octets', () => {
    expect(parseIPv4('0xab.0.0.0')).toBeNull();
    expect(parseIPv4('0x7f.0x00.0x00.0x01')).toBeNull();
    expect(parseIPv4('0XAB.0.0.0')).toBeNull();
  });

  it('BAD: rejects invalid IP formats', () => {
    expect(parseIPv4('not.an.ip.address')).toBeNull();
    expect(parseIPv4('')).toBeNull();
    expect(parseIPv4('1.2.3')).toBeNull();
    expect(parseIPv4('1.2.3.4.5')).toBeNull();
  });

  it('EDGE: preserves existing leading-zero decimal behavior', () => {
    expect(parseIPv4('010.0.0.1')).toBe(((10 << 24) | 1) >>> 0);
    expect(parseIPv4('192.168.001.001')).toBe(((192 << 24) | (168 << 16) | (1 << 8) | 1) >>> 0);
  });
});
