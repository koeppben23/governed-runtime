import { describe, expect, it } from 'vitest';
import { PkijsTimestampVerifier } from './rfc-3161-pkijs-verifier.js';
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

describe('PkijsTimestampVerifier', () => {
  it('valid RFC-3161 token verifies against trust anchor', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toMatchObject({ status: 'valid', policyOid: RFC3161_TEST_POLICY_OID });
  });

  it('messageImprint equals canonical event digest', async () => {
    const fixture = await makeRfc3161Fixture({ digest: DIGEST });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result.status).toBe('valid');
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
      expectedDigest: WRONG_DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'digest_mismatch' });
  });

  it('untrusted TSA certificate returns untrusted_cert', async () => {
    const fixture = await makeRfc3161Fixture();
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
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
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
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
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'cert_not_yet_valid' });
  });

  it('unsupported digest algorithm returns unsupported_algorithm', async () => {
    const fixture = await makeRfc3161Fixture({ digestOid: '1.3.14.3.2.26' });
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'unsupported_algorithm' });
  });

  it('malformed ASN.1/CMS returns malformed_token', async () => {
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: Buffer.from('not der').toString('base64'),
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'malformed_token' });
  });

  it('tampered signature returns untrusted_cert', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_signature');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'untrusted_cert' });
  });

  it('tampered TSTInfo returns signed_attrs_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('tampered_tst_info');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signed_attrs_invalid' });
  });

  it('message digest mismatch in signedAttrs returns signed_attrs_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('digest_mismatch_in_signed_attrs');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signed_attrs_invalid' });
  });

  it('wrong content-type in signedAttrs returns signed_attrs_invalid', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_content_type_in_signed_attrs');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'signed_attrs_invalid' });
  });

  it('wrong CMS eContentType returns malformed_token', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_econtent_type');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'malformed_token' });
  });

  it('missing signerInfo returns missing_signer_info', async () => {
    const fixture = await makeRfc3161TamperedFixture('no_signer_info');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'missing_signer_info' });
  });

  it('missing signer certificate returns missing_signer_info', async () => {
    const fixture = await makeRfc3161TamperedFixture('no_certificate');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'missing_signer_info' });
  });

  it('signerInfo sid mismatch returns missing_signer_info', async () => {
    const fixture = await makeRfc3161TamperedFixture('wrong_signer_sid');
    const result = await new PkijsTimestampVerifier().verifyToken({
      tokenDerBase64: fixture.tokenDerBase64,
      expectedDigest: DIGEST,
      digestAlgorithm: 'sha256',
      trustAnchors: [fixture.trustAnchorPem],
    });

    expect(result).toEqual({ status: 'invalid', reason: 'missing_signer_info' });
  });
});
