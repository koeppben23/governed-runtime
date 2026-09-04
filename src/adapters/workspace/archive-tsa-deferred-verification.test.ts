/**
 * @module workspace/archive-tsa-deferred-verification
 * @description End-to-end proof that a valid RFC3161 token survives archive
 *              verification, using real cryptographic material.
 *
 * The synchronous chain verifier refuses to trust the mutable cached
 * `messageImprint` whenever a non-empty `tokenDerBase64` is present, and
 * reports `TOKEN_VERIFICATION_REQUIRED` to defer to the asynchronous RFC3161
 * verifier. Projecting that deferral into a `tsa_verification_failed` finding
 * made a correctly signed, trusted token fail the archive: archive findings are
 * append-only, so the later successful cryptographic verification could not
 * retract the earlier failure.
 *
 * These tests compose the two authorities exactly as `verifyTimestampChain`
 * does — chain verification first, then token verification — with a token
 * issued over the real canonical event digest and a matching trust anchor.
 */

import { describe, expect, it } from 'vitest';
import { makeState } from '../../fixtures.js';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import { ARCHIVE_LAYOUT_VERSION, ARCHIVE_MANIFEST_SCHEMA_VERSION } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import { verifyChain } from '../../audit/integrity.js';
import {
  computeChainHash,
  createTransitionEvent,
  GENESIS_HASH,
  type ChainedAuditEvent,
} from '../../audit/types.js';
import { computeCanonicalEventDigests } from '../../audit/canonical-digest.js';
import { SESSION_ID, stampChainSequence } from '../../audit/audit-test-helpers.js';
import { makeRfc3161FixtureAuthority } from '../../audit/__fixtures__/rfc3161.js';
import { verifyArchiveTimestampTokens } from './archive-timestamp-verification.js';
import { isDeferredTimestampReason } from './archive-verify-helpers.js';
import { addTimestampFindings } from './archive-verify-chain.js';

const FINGERPRINT = 'aaaabbbbccccddddeeeeffff';
const OCCURRED_AT = '2026-01-01T00:00:00.000Z';

function manifest(): ArchiveManifest {
  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    layoutVersion: ARCHIVE_LAYOUT_VERSION,
    createdAt: OCCURRED_AT,
    sessionId: SESSION_ID,
    fingerprint: FINGERPRINT,
    policyMode: 'regulated',
    profileId: 'baseline',
    discoveryDigest: null,
    auditChainHead: 'genesis',
    auditEventCount: 1,
    includedFiles: [],
    fileDigests: {},
    contentDigest: '',
  };
}

function stateWithAnchors(trustAnchors: readonly string[]): SessionState {
  const base = makeState('COMPLETE');
  return makeState('COMPLETE', {
    policySnapshot: {
      ...base.policySnapshot,
      audit: {
        ...base.policySnapshot.audit,
        timestampAssurance: {
          enabled: true,
          mode: 'tsa_critical',
          strict: true,
          criticalEvents: ['decision', 'lifecycle'],
          tsaUrl: 'https://tsa.example.test',
          trustAnchors: [...trustAnchors],
          ntpServers: ['pool.ntp.org'],
          ntpDriftThresholdMs: 30000,
          tsaTimeoutMs: 10000,
        },
      },
    },
  });
}

const TRANSITION = {
  from: 'TICKET',
  to: 'PLAN',
  event: 'PLAN_READY',
  autoAdvanced: false,
  chainIndex: 0,
} as const;

/**
 * Build a stamped, chain-valid event whose TSA token is issued over the REAL
 * canonical digest of that same event.
 *
 * The canonical content excludes 	imestampEvidence and chainHash, so the
 * digest is computed on the finished event and stays valid when the real token
 * is substituted for the placeholder and the chain hash is recomputed.
 */
async function stampedEventWithRealToken(options: { readonly bindToWrongDigest?: boolean } = {}) {
  const authority = await makeRfc3161FixtureAuthority();

  const evidence = (tokenDerBase64: string, messageImprint: string) =>
    ({
      status: 'tsa_stamped',
      source: 'tsa',
      resolvedAt: OCCURRED_AT,
      tsa: {
        tokenDerBase64,
        receivedAt: OCCURRED_AT,
        messageImprint,
        digestAlgorithm: 'sha256',
        verificationStatus: 'unchecked',
      },
    }) as never;

  const placeholder = stampChainSequence(
    createTransitionEvent(
      SESSION_ID,
      'PLAN',
      TRANSITION,
      OCCURRED_AT,
      GENESIS_HASH,
      evidence('AA==', 'f'.repeat(64)),
    ),
    1,
  );

  const canonical = computeCanonicalEventDigests(
    placeholder as unknown as Record<string, unknown>,
  ).sha256;
  const bound = options.bindToWrongDigest
    ? Uint8Array.from(canonical, (byte) => byte ^ 0xff)
    : canonical;

  const { tokenDerBase64 } = await authority.issue({
    digest: bound,
    genTime: new Date(OCCURRED_AT),
  });

  const { chainHash: _placeholderHash, ...body } = placeholder;
  const stampedBody = {
    ...body,
    timestampEvidence: evidence(tokenDerBase64, Buffer.from(bound).toString('hex')),
  } as unknown as Omit<ChainedAuditEvent, 'chainHash'>;

  return {
    event: {
      ...stampedBody,
      chainHash: computeChainHash(GENESIS_HASH, stampedBody),
    } as unknown as AuditEvent,
    trustAnchorPem: authority.trustAnchorPem,
  };
}
describe('archive TSA deferred verification', () => {
  it('accepts a valid RFC3161 token against its trust anchor without any finding', async () => {
    const { event, trustAnchorPem } = await stampedEventWithRealToken();

    // The synchronous layer defers — it cannot verify the token itself.
    const chainResult = verifyChain([event as unknown as Record<string, unknown>], {
      strictTimestamps: true,
    });
    expect(chainResult.reason).toBe('TOKEN_VERIFICATION_REQUIRED');
    expect(isDeferredTimestampReason(chainResult.reason)).toBe(true);
    const chainFindings: ArchiveFinding[] = [];
    addTimestampFindings(chainResult, true, chainFindings);
    expect(chainFindings).toEqual([]);

    // The asynchronous layer is the verdict authority, and it verifies.
    const findings: ArchiveFinding[] = [];
    await verifyArchiveTimestampTokens({
      events: [event],
      state: stateWithAnchors([trustAnchorPem]),
      manifest: manifest(),
      findings,
      fatal: true,
    });

    expect(findings).toEqual([]);
  }, 30_000);

  it('still rejects a token bound to a different digest', async () => {
    // Fail-closed direction: deferring must not become accepting.
    const { event, trustAnchorPem } = await stampedEventWithRealToken({
      bindToWrongDigest: true,
    });

    const findings: ArchiveFinding[] = [];
    await verifyArchiveTimestampTokens({
      events: [event],
      state: stateWithAnchors([trustAnchorPem]),
      manifest: manifest(),
      findings,
      fatal: true,
    });

    expect(findings.map((finding) => finding.code)).toContain('tsa_verification_failed');
  }, 30_000);

  it('still rejects a valid token that is not covered by the configured anchor', async () => {
    const { event } = await stampedEventWithRealToken();
    const foreign = await makeRfc3161FixtureAuthority();

    const findings: ArchiveFinding[] = [];
    await verifyArchiveTimestampTokens({
      events: [event],
      state: stateWithAnchors([foreign.trustAnchorPem]),
      manifest: manifest(),
      findings,
      fatal: true,
    });

    expect(findings.map((finding) => finding.code)).toContain('tsa_verification_failed');
  }, 30_000);

  it('still rejects TSA evidence when no trust anchor is configured', async () => {
    // The deferral relies on the async layer covering every non-empty token.
    // With no anchors it cannot verify, and must say so rather than stay silent.
    const { event } = await stampedEventWithRealToken();

    const findings: ArchiveFinding[] = [];
    await verifyArchiveTimestampTokens({
      events: [event],
      state: stateWithAnchors([]),
      manifest: manifest(),
      findings,
      fatal: true,
    });

    expect(findings.map((finding) => finding.code)).toContain('tsa_verification_failed');
  }, 30_000);
});
