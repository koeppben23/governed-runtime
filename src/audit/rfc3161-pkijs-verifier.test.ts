import { describe, expect, it } from 'vitest';
import {
  PkijsTimestampVerifier,
  decideSignatureAlgorithm,
  digestKindFromOid,
  oidFromParams,
  pssHashKind,
  signatureDigestKindFromOid,
  webcryptoHashName,
} from './rfc-3161-pkijs-verifier.js';
import { RSASSAPSSParams } from 'pkijs';
import { AlgorithmIdentifier } from 'pkijs';
import * as asn1js from 'asn1js';
import { verifyTimestampTokensForEvents } from './timestamp-token-verification.js';
import { computeCanonicalEventDigest } from './canonical-digest.js';
import { canonicalDigestToUint8Array } from './timestamp-verification.js';
import { makeAuditEvent } from './audit-test-helpers.js';
import type { AuditEvent } from '../state/evidence.js';
import {
  makeRfc3161Fixture,
  makeRfc3161TamperedFixture,
  RFC3161_TEST_DIGEST,
  RFC3161_TEST_POLICY_OID,
} from './__fixtures__/rfc3161.js';

const DIGEST = RFC3161_TEST_DIGEST;
const WRONG_DIGEST = new Uint8Array(Array.from({ length: 32 }, (_, i) => 255 - i));
const OID_SHA384 = '2.16.840.1.101.3.4.2.2';

/**
 * Direct verifier tests only ever know the SHA-256 digest; the sha384/sha512
 * slots are EMPTY so a token declaring another algorithm fails the
 * constant-time comparison closed (TSA2).
 */
function expectedDigestsFor(sha256: Uint8Array): {
  sha256: Uint8Array;
  sha384: Uint8Array;
  sha512: Uint8Array;
} {
  return { sha256, sha384: new Uint8Array(0), sha512: new Uint8Array(0) };
}

describe('PkijsTimestampVerifier', () => {
  describe('authority mapping functions (direct unit pins)', () => {
    it('digestKindFromOid maps all allowlisted digests and rejects unknown OIDs', () => {
      expect(digestKindFromOid('2.16.840.1.101.3.4.2.1')).toBe('sha256');
      expect(digestKindFromOid('2.16.840.1.101.3.4.2.2')).toBe('sha384');
      expect(digestKindFromOid('2.16.840.1.101.3.4.2.3')).toBe('sha512');
      expect(digestKindFromOid('1.3.14.3.2.26')).toBeNull();
    });

    it('oidFromParams extracts the algorithm OID from a parsed slot', () => {
      expect(oidFromParams({ algorithmId: '1.2.840.113549.1.1.8' })).toBe('1.2.840.113549.1.1.8');
      expect(oidFromParams({})).toBeNull();
      expect(oidFromParams({ algorithmId: 42 })).toBeNull();
    });

    it('webcryptoHashName maps every digest kind', () => {
      expect(webcryptoHashName('sha256')).toBe('SHA-256');
      expect(webcryptoHashName('sha384')).toBe('SHA-384');
      expect(webcryptoHashName('sha512')).toBe('SHA-512');
    });

    it('signatureDigestKindFromOid maps all six listed algorithms and rejects unknowns', () => {
      expect(signatureDigestKindFromOid('1.2.840.113549.1.1.11')).toBe('sha256');
      expect(signatureDigestKindFromOid('1.2.840.10045.4.3.2')).toBe('sha256');
      expect(signatureDigestKindFromOid('1.2.840.113549.1.1.12')).toBe('sha384');
      expect(signatureDigestKindFromOid('1.2.840.10045.4.3.3')).toBe('sha384');
      expect(signatureDigestKindFromOid('1.2.840.113549.1.1.13')).toBe('sha512');
      expect(signatureDigestKindFromOid('1.2.840.10045.4.3.4')).toBe('sha512');
      expect(signatureDigestKindFromOid('1.2.840.113549.1.1.4')).toBeNull();
    });

    function pssParams(overrides: {
      hashOid?: string;
      mgfOid?: string;
      mgfHashOid?: string;
      saltLength?: number;
      trailerField?: number;
    }): RSASSAPSSParams {
      return new RSASSAPSSParams({
        hashAlgorithm: new AlgorithmIdentifier({
          algorithmId: overrides.hashOid ?? '2.16.840.1.101.3.4.2.1',
        }),
        maskGenAlgorithm: new AlgorithmIdentifier({
          algorithmId: overrides.mgfOid ?? '1.2.840.113549.1.1.8',
          algorithmParams: new AlgorithmIdentifier({
            algorithmId: overrides.mgfHashOid ?? '2.16.840.1.101.3.4.2.1',
          }).toSchema(),
        }),
        saltLength: overrides.saltLength ?? 32,
        trailerField: overrides.trailerField ?? 1,
      });
    }

    it('pssHashKind accepts the full in-profile parameter space', () => {
      expect(pssHashKind(pssParams({}), 'sha256')).toBe('sha256');
      expect(
        pssHashKind(
          pssParams({ hashOid: '2.16.840.1.101.3.4.2.2', mgfHashOid: '2.16.840.1.101.3.4.2.2' }),
          'sha384',
        ),
      ).toBe('sha384');
      expect(pssHashKind(pssParams({ saltLength: 8 }), 'sha256')).toBe('sha256');
    });

    it('pssHashKind applies the per-kind salt ceiling (digest byte length)', () => {
      // 40 bytes of salt fit the SHA-384 (48) and SHA-512 (64) ceilings but
      // exceed the SHA-256 ceiling (32).
      expect(
        pssHashKind(
          pssParams({
            hashOid: '2.16.840.1.101.3.4.2.2',
            mgfHashOid: '2.16.840.1.101.3.4.2.2',
            saltLength: 40,
          }),
          'sha384',
        ),
      ).toBe('sha384');
      expect(
        pssHashKind(
          pssParams({
            hashOid: '2.16.840.1.101.3.4.2.3',
            mgfHashOid: '2.16.840.1.101.3.4.2.3',
            saltLength: 40,
          }),
          'sha512',
        ),
      ).toBe('sha512');
      expect(pssHashKind(pssParams({ saltLength: 40 }), 'sha256')).toBeNull();
      expect(pssHashKind(pssParams({ saltLength: 33 }), 'sha256')).toBeNull();
    });

    it('pssHashKind rejects every out-of-profile parameter dimension', () => {
      // hash not allowlisted / not matching the CMS digest kind
      expect(pssHashKind(pssParams({ hashOid: '1.3.14.3.2.26' }), 'sha256')).toBeNull();
      expect(
        pssHashKind(
          pssParams({ hashOid: '2.16.840.1.101.3.4.2.2', mgfHashOid: '2.16.840.1.101.3.4.2.2' }),
          'sha256',
        ),
      ).toBeNull();
      // non-MGF1 mask
      expect(pssHashKind(pssParams({ mgfOid: '1.2.840.113549.1.9.16.3.8' }), 'sha256')).toBeNull();
      // MGF hash diverging from the signature hash
      expect(pssHashKind(pssParams({ mgfHashOid: '2.16.840.1.101.3.4.2.2' }), 'sha256')).toBeNull();
      // trailerField != 1
      expect(pssHashKind(pssParams({ trailerField: 2 }), 'sha256')).toBeNull();
      // salt below the floor and above the digest length
      expect(pssHashKind(pssParams({ saltLength: 0 }), 'sha256')).toBeNull();
      expect(pssHashKind(pssParams({ saltLength: 40 }), 'sha256')).toBeNull();
      // unparseable parameters
      expect(pssHashKind(new asn1js.Sequence(), 'sha256')).toBeNull();
    });

    it('decideSignatureAlgorithm rejects unlisted and incoherent PSS parameters', () => {
      const unlisted = decideSignatureAlgorithm(
        { signatureAlgorithm: { algorithmId: '1.2.840.113549.1.1.4' } },
        'sha256',
      );
      expect('rejection' in unlisted && unlisted.rejection.reason).toBe(
        'unsafe_signature_algorithm',
      );

      const badParams = decideSignatureAlgorithm(
        {
          signatureAlgorithm: {
            algorithmId: '1.2.840.113549.1.1.10',
            algorithmParams: new asn1js.Sequence(),
          },
        },
        'sha256',
      );
      expect('rejection' in badParams && badParams.rejection.reason).toBe(
        'unsafe_signature_algorithm',
      );

      const mismatchedHash = decideSignatureAlgorithm(
        {
          signatureAlgorithm: {
            algorithmId: '1.2.840.113549.1.1.12',
          },
        },
        'sha256',
      );
      expect('rejection' in mismatchedHash && mismatchedHash.rejection.reason).toBe(
        'unsafe_signature_algorithm',
      );
    });
  });

  it('valid RFC-3161 token verifies against trust anchor', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({
      status: 'valid',
      policyOid: RFC3161_TEST_POLICY_OID,
      digestAlgorithm: 'sha256',
      signerSubject: '2.5.4.3=FlowGuard Test TSA',
      messageImprintHex: expect.stringMatching(/^[0-9a-f]{64}$/),
      serialNumber: expect.any(String),
    });
  });

  it('valid RFC-3161 token with a SHA-512 imprint verifies (TSA2 allowlist)', async () => {
    const sha512Digest = new Uint8Array(64).fill(9);
    const fixture = await makeRfc3161Fixture({
      digest: sha512Digest,
      digestOid: '2.16.840.1.101.3.4.2.3',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: { ...expectedDigestsFor(DIGEST), sha512: sha512Digest },
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid', digestAlgorithm: 'sha512' });
  });

  it('token with genTime exactly at the certificate notAfter verifies', async () => {
    const boundary = new Date('2027-01-01T00:00:00.000Z');
    const fixture = await makeRfc3161Fixture({ genTime: boundary, notAfter: boundary });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid' });
  });

  it('token with genTime exactly at the certificate notBefore verifies', async () => {
    const boundary = new Date('2025-01-01T00:00:00.000Z');
    const fixture = await makeRfc3161Fixture({ genTime: boundary, notBefore: boundary });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid' });
  });

  it('empty trust anchor PEM returns malformed_token', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [''],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'malformed_token' });
  });

  it('wrong CMS content type returns malformed_token', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_cms_content_type');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'malformed_token' });
  });

  it('signature hash diverging from the CMS digest returns unsafe_signature_algorithm (TSA2)', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_signature_algorithm_sha384');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
      expect(result.detail).toContain('does not match');
    }
  });

  it('an empty signer subject renders signerSubject undefined', async () => {
    const fixture = await makeRfc3161Fixture({ emptySubject: true });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid', signerSubject: undefined });
  });

  it('a valid token with NO trust anchors returns untrusted_cert', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'untrusted_cert' });
  });

  it('TSA1: an EKU missing id-kp-timeStamping returns missing_tsa_eku', async () => {
    const fixture = await makeRfc3161Fixture({ eku: 'other' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      status: 'invalid',
      reason: 'missing_tsa_eku',
      detail: expect.stringContaining('id-kp-timeStamping'),
    });
  });

  it('messageImprint equals canonical event digest', async () => {
    const fixture = await makeRfc3161Fixture({ digest: DIGEST });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('valid');
  });

  it('verifies when only ONE of several trust anchors matches (binding is some, not every)', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.untrustedAnchorPem, fixture.trustAnchorPem],
    });

    expect(result.status).toBe('valid');
  });

  it('rejects when NO trust anchor matches, even with multiple anchors', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.untrustedAnchorPem, fixture.untrustedAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'untrusted_cert' });
  });

  it('verifies a token whose eContent is a constructed multi-part octet string', async () => {
    const fixture = await makeRfc3161Fixture({ multiPartEContent: true });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('valid');
  });

  it('valid RFC-3161 token with a SHA-384 imprint verifies (TSA2 allowlist)', async () => {
    const sha384Digest = new Uint8Array(48).fill(7);
    const fixture = await makeRfc3161Fixture({ digest: sha384Digest, digestOid: OID_SHA384 });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: { ...expectedDigestsFor(DIGEST), sha384: sha384Digest },
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid', digestAlgorithm: 'sha384' });
  });

  it('SHA-384 imprint with a wrong expected digest returns digest_mismatch', async () => {
    const sha384Digest = new Uint8Array(48).fill(7);
    const fixture = await makeRfc3161Fixture({ digest: sha384Digest, digestOid: OID_SHA384 });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'digest_mismatch' });
  });

  it('token verification cross-checks cached imprint against token-derived imprint', async () => {
    const event = makeAuditEvent({ event: 'decision:DEC-001' });
    const canonicalDigest = computeCanonicalEventDigest(event as Record<string, unknown>);
    const fixture = await makeRfc3161Fixture({
      digest: canonicalDigestToUint8Array(canonicalDigest),
    });
    const stamped = {
      ...event,
      canonicalEventDigest: canonicalDigest,
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: fixture.tokenDerBase64,
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked',
          digestAlgorithm: 'sha256',
          messageImprint: '0'.repeat(64),
        },
      },
    } as unknown as AuditEvent;

    const result = await verifyTimestampTokensForEvents({
      events: [stamped],
      verifier: new PkijsTimestampVerifier(),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      valid: false,
      findings: [{ index: 0, reason: 'cached_message_imprint_mismatch' }],
    });
  });

  it('AC9: a valid token whose cached imprint is missing is an explicit finding', async () => {
    const event = makeAuditEvent({ event: 'decision:DEC-001' });
    const canonicalDigest = computeCanonicalEventDigest(event as Record<string, unknown>);
    const fixture = await makeRfc3161Fixture({
      digest: canonicalDigestToUint8Array(canonicalDigest),
    });
    const stamped = {
      ...event,
      canonicalEventDigest: canonicalDigest,
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: fixture.tokenDerBase64,
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked',
          digestAlgorithm: 'sha256',
        },
      },
    } as unknown as AuditEvent;

    const result = await verifyTimestampTokensForEvents({
      events: [stamped],
      verifier: new PkijsTimestampVerifier(),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      valid: false,
      findings: [{ index: 0, reason: 'missing_cached_message_imprint' }],
    });
  });

  it('AC9: a valid token whose cached imprint is malformed is an explicit finding', async () => {
    const event = makeAuditEvent({ event: 'decision:DEC-001' });
    const canonicalDigest = computeCanonicalEventDigest(event as Record<string, unknown>);
    const fixture = await makeRfc3161Fixture({
      digest: canonicalDigestToUint8Array(canonicalDigest),
    });
    const stamped = {
      ...event,
      canonicalEventDigest: canonicalDigest,
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: fixture.tokenDerBase64,
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked',
          digestAlgorithm: 'sha256',
          messageImprint: 'not-a-hex-imprint',
        },
      },
    } as unknown as AuditEvent;

    const result = await verifyTimestampTokensForEvents({
      events: [stamped],
      verifier: new PkijsTimestampVerifier(),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      valid: false,
      findings: [{ index: 0, reason: 'malformed_cached_message_imprint' }],
    });
  });

  it('token verification rejects coordinated edits to stored digest and cached imprint', async () => {
    const event = makeAuditEvent({
      event: 'decision:DEC-001',
      detail: { kind: 'decision', verdict: 'approve', nested: { reviewed: true } },
    });
    const originalDigest = computeCanonicalEventDigest(event as Record<string, unknown>);
    const fixture = await makeRfc3161Fixture({
      digest: canonicalDigestToUint8Array(originalDigest),
    });
    const stamped = {
      ...event,
      canonicalEventDigest: originalDigest,
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: fixture.tokenDerBase64,
          receivedAt: '2026-01-01T00:00:01.000Z',
          verificationStatus: 'unchecked',
          digestAlgorithm: 'sha256',
          messageImprint: originalDigest,
        },
      },
    } as unknown as AuditEvent;
    const tampered = {
      ...stamped,
      detail: {
        ...stamped.detail,
        nested: { reviewed: false, attackerEdited: true },
      },
    } as unknown as AuditEvent;
    const attackerDigest = computeCanonicalEventDigest(tampered as Record<string, unknown>);
    const evidence = (tampered as Record<string, unknown>).timestampEvidence as Record<
      string,
      unknown
    >;
    const tsa = evidence.tsa as Record<string, unknown>;
    const coordinatedLocalEdit = {
      ...tampered,
      canonicalEventDigest: attackerDigest,
      timestampEvidence: {
        ...evidence,
        tsa: {
          ...tsa,
          messageImprint: attackerDigest,
        },
      },
    } as unknown as AuditEvent;

    const result = await verifyTimestampTokensForEvents({
      events: [coordinatedLocalEdit],
      verifier: new PkijsTimestampVerifier(),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      valid: false,
      findings: [{ index: 0, reason: 'digest_mismatch' }],
    });
  });

  it('wrong digest returns digest_mismatch', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(WRONG_DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'digest_mismatch' });
  });

  it('untrusted TSA certificate returns untrusted_cert', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.untrustedAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'untrusted_cert' });
  });

  it('expired TSA certificate returns cert_expired', async () => {
    const fixture = await makeRfc3161Fixture({
      notBefore: new Date('2020-01-01T00:00:00.000Z'),
      notAfter: new Date('2021-01-01T00:00:00.000Z'),
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'cert_expired' });
  });

  it('not-yet-valid TSA certificate returns cert_not_yet_valid', async () => {
    const fixture = await makeRfc3161Fixture({
      notBefore: new Date('2030-01-01T00:00:00.000Z'),
      notAfter: new Date('2031-01-01T00:00:00.000Z'),
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'cert_not_yet_valid' });
  });

  it('unlisted digest algorithm returns unsafe_digest_algorithm (TSA2)', async () => {
    const fixture = await makeRfc3161Fixture({ digestOid: '1.3.14.3.2.26' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_digest_algorithm');
      expect(result.detail).toContain('1.3.14.3.2.26');
    }
  });

  it('accepts a SHA-256 imprint with a SHA-384 CMS signature (RFC 8933)', async () => {
    const fixture = await makeRfc3161Fixture({ cmsDigestOid: OID_SHA384 });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid', digestAlgorithm: 'sha256' });
  });

  it('unlisted signature algorithm returns unsafe_signature_algorithm (TSA2)', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_signature_algorithm');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA1: signer without extendedKeyUsage returns missing_tsa_eku', async () => {
    const fixture = await makeRfc3161Fixture({ eku: 'none' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      status: 'invalid',
      reason: 'missing_tsa_eku',
      detail: expect.any(String),
    });
  });

  it('TSA1: non-critical extendedKeyUsage returns missing_tsa_eku', async () => {
    const fixture = await makeRfc3161Fixture({ eku: 'non_critical' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      status: 'invalid',
      reason: 'missing_tsa_eku',
      detail: expect.any(String),
    });
  });

  it('TSA1: additional key purposes return non_exclusive_tsa_eku (exclusive profile)', async () => {
    const fixture = await makeRfc3161Fixture({ eku: 'extra' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      status: 'invalid',
      reason: 'non_exclusive_tsa_eku',
      detail: expect.stringContaining('1.3.6.1.5.5.7.3.2'),
    });
  });

  it('TSA1: duplicate extendedKeyUsage extensions are rejected', async () => {
    const fixture = await makeRfc3161Fixture({ duplicateEku: true });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      status: 'invalid',
      reason: 'duplicate_tsa_eku',
      detail: expect.any(String),
    });
  });

  it('RFC 5816: missing signed certificate binding returns signing_certificate_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('missing_signing_certificate');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signing_certificate_invalid' });
  });

  it.each(['v1', 'v2', 'both'] as const)(
    'RFC 5816: accepts a valid %s signing certificate binding',
    async (certificateBinding) => {
      const fixture = await makeRfc3161Fixture({ certificateBinding });
      const result = await new PkijsTimestampVerifier().verifyToken({
        tokenDerBase64: fixture.tokenDerBase64,
        expectedDigests: expectedDigestsFor(DIGEST),
        trustAnchors: [fixture.trustAnchorPem],
      });

      expect(result).toMatchObject({ status: 'valid' });
    },
  );

  it('TSA3: unknown critical extension returns unhandled_critical_extension', async () => {
    const fixture = await makeRfc3161Fixture({ unknownCriticalExtension: true });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({
      status: 'invalid',
      reason: 'unhandled_critical_extension',
      detail: expect.any(String),
    });
  });

  it('TSA2: RSASSA-PSS with validated parameters verifies', async () => {
    const fixture = await makeRfc3161Fixture({ keyScheme: 'pss' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid' });
  });

  it('TSA2: RSASSA-PSS with invalid parameters returns unsafe_signature_algorithm', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_params');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA2: RSASSA-PSS with an out-of-profile saltLength returns unsafe_signature_algorithm', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_salt_length', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
      expect(result.detail).toContain('PSS');
    }
  });

  it('TSA2: RSASSA-PSS with the minimum saltLength verifies (boundary)', async () => {
    const fixture = await makeRfc3161Fixture({ keyScheme: 'pss', pssSaltLength: 8 });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid' });
  });

  it('TSA2: RSASSA-PSS with zero salt returns unsafe_signature_algorithm', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_salt_zero', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA2: RSASSA-PSS salt beyond the digest length returns unsafe_signature_algorithm', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_salt_40', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA2: RSASSA-PSS with a non-MGF1 mask returns unsafe_signature_algorithm', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_mask_gen', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA2: RSASSA-PSS with an MGF hash diverging from the signature hash is rejected', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_mgf_hash', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA2: RSASSA-PSS hash diverging from the CMS digest is rejected', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_hash_sha384', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('TSA2: RSASSA-PSS with trailerField != 1 returns unsafe_signature_algorithm', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_pss_trailer_field', {
      keyScheme: 'pss',
    });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('invalid');
    if (result.status === 'invalid') {
      expect(result.reason).toBe('unsafe_signature_algorithm');
    }
  });

  it('malformed ASN.1/CMS returns malformed_token', async () => {
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: Buffer.from('not der').toString('base64'),
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'malformed_token' });
  });

  it('tampered signature returns untrusted_cert', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_signature');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'untrusted_cert' });
  });

  it('tampered TSTInfo returns signed_attrs_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_tst_info');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signed_attrs_invalid' });
  });

  it('message digest mismatch in signedAttrs returns signed_attrs_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('digest_mismatch_in_signed_attrs');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signed_attrs_invalid' });
  });

  it('wrong content-type in signedAttrs returns signed_attrs_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_content_type_in_signed_attrs');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signed_attrs_invalid' });
  });

  it('wrong CMS eContentType returns malformed_token', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_econtent_type');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'malformed_token' });
  });

  it('missing signerInfo returns missing_signer_info', async () => {
    const fixture = await makeRfc3161TamperedFixture('no_signer_info');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'missing_signer_info' });
  });

  it('missing signer certificate returns missing_signer_info', async () => {
    const fixture = await makeRfc3161TamperedFixture('no_certificate');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'missing_signer_info' });
  });

  it('signerInfo sid mismatch returns missing_signer_info', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_signer_sid');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigests: expectedDigestsFor(DIGEST),
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'missing_signer_info' });
  });
});
