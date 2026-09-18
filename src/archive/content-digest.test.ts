/**
 * @module archive/content-digest.test
 * @description Direct contract tests for the archive content digest authority.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, COMPATIBILITY
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { computeArchiveContentDigest, type ArchiveContentDigestInput } from './content-digest.js';

const DIGEST_A = 'a'.repeat(64);
const DIGEST_B = 'b'.repeat(64);
const DIGEST_C = 'c'.repeat(64);

function baseInput(): ArchiveContentDigestInput {
  return {
    schemaVersion: 'archive-manifest.v3',
    layoutVersion: 2,
    sessionId: 'ses_test',
    fingerprint: '1234567890abcdef12345678',
    policyMode: 'regulated',
    discoveryDigest: DIGEST_C,
    auditChainHead: DIGEST_A,
    auditEventCount: 7,
    includedFiles: ['audit.jsonl', 'session-state.json'],
    fileDigests: {
      'audit.jsonl': DIGEST_A,
      'session-state.json': DIGEST_B,
    },
  };
}

describe('computeArchiveContentDigest', () => {
  it('HAPPY: returns a stable SHA-256 hex digest for identical input', () => {
    const input = baseInput();

    expect(computeArchiveContentDigest(input)).toMatch(/^[a-f0-9]{64}$/);
    expect(computeArchiveContentDigest(input)).toBe(computeArchiveContentDigest(input));
  });

  it('COMPATIBILITY: pins the v3 canonical digest golden vector', () => {
    // The digest is a persistence/integrity contract. If this vector changes,
    // the digest formula changed and the manifest schema version MUST change
    // with it — never silently.
    expect(computeArchiveContentDigest(baseInput())).toBe(
      '9f45203d0d839c01d57d27b5557b92042f8d701d36c1d9de37b48fc8e4868c8d',
    );
  });

  it('COMPATIBILITY: the retired v2 literal-order digest differs from the v3 canonical digest', () => {
    // v2 serialized the integrity header with literal insertion order. The
    // canonical serializer sorts keys, so the epoch boundary must be real:
    // there is no silent byte carry-over between v2 and v3.
    const input: ArchiveContentDigestInput = {
      ...baseInput(),
      schemaVersion: 'archive-manifest.v2',
    };
    const v2Header = JSON.stringify({
      schemaVersion: 'archive-manifest.v2',
      layoutVersion: 2,
      sessionId: 'ses_test',
      fingerprint: '1234567890abcdef12345678',
      policyMode: 'regulated',
      discoveryDigest: DIGEST_C,
      auditChainHead: DIGEST_A,
      auditEventCount: 7,
    });
    const v2Digest = createHash('sha256')
      .update(v2Header)
      .update('\n')
      .update([DIGEST_A, DIGEST_B].sort().join(''))
      .digest('hex');

    expect(computeArchiveContentDigest(input)).not.toBe(v2Digest);
  });

  it.each([
    ['schemaVersion', { schemaVersion: 'archive-manifest.v4' }],
    ['layoutVersion', { layoutVersion: 3 }],
    ['sessionId', { sessionId: 'ses_other' }],
    ['fingerprint', { fingerprint: 'fedcba0987654321fedcba09' }],
    ['policyMode', { policyMode: 'team' }],
    ['discoveryDigest', { discoveryDigest: null }],
    ['auditChainHead', { auditChainHead: DIGEST_B }],
    ['auditEventCount', { auditEventCount: 8 }],
  ] as const)('BAD: changing integrity header field %s changes the digest', (_field, patch) => {
    const input = baseInput();
    const changed = { ...input, ...patch };

    expect(computeArchiveContentDigest(changed)).not.toBe(computeArchiveContentDigest(input));
  });

  it('BAD: changing a file digest changes the digest', () => {
    const input = baseInput();
    const changed: ArchiveContentDigestInput = {
      ...input,
      fileDigests: { ...input.fileDigests, 'session-state.json': DIGEST_C },
    };

    expect(computeArchiveContentDigest(changed)).not.toBe(computeArchiveContentDigest(input));
  });

  it('BAD: throws MISSING_FILE_DIGEST when an included file has no digest', () => {
    const input: ArchiveContentDigestInput = {
      ...baseInput(),
      fileDigests: { 'audit.jsonl': DIGEST_A },
    };

    expect(() => computeArchiveContentDigest(input)).toThrowError(
      expect.objectContaining({
        code: 'MISSING_FILE_DIGEST',
        message: "Missing file digest for included archive file 'session-state.json'",
      }),
    );
  });

  it('CORNER: equivalent included-file order is deterministic', () => {
    const input = baseInput();
    const reordered: ArchiveContentDigestInput = {
      ...input,
      includedFiles: ['session-state.json', 'audit.jsonl'],
    };

    expect(computeArchiveContentDigest(reordered)).toBe(computeArchiveContentDigest(input));
  });

  it('CORNER: fileDigests property insertion order does not affect the digest', () => {
    const input = baseInput();
    const reinserted: ArchiveContentDigestInput = {
      ...input,
      fileDigests: {
        'session-state.json': DIGEST_B,
        'audit.jsonl': DIGEST_A,
      },
    };

    expect(computeArchiveContentDigest(reinserted)).toBe(computeArchiveContentDigest(input));
  });

  it('EDGE: null and concrete discovery digests are distinct', () => {
    const withDiscovery = baseInput();
    const withoutDiscovery: ArchiveContentDigestInput = {
      ...withDiscovery,
      discoveryDigest: null,
    };

    expect(computeArchiveContentDigest(withoutDiscovery)).not.toBe(
      computeArchiveContentDigest(withDiscovery),
    );
  });
});
