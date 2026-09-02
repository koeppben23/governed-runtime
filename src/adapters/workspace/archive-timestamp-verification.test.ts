import { describe, expect, it } from 'vitest';
import { makeState } from '../../fixtures.js';
import type { ArchiveFinding, ArchiveManifest, ManifestPolicyMode } from '../../archive/types.js';
import { ARCHIVE_LAYOUT_VERSION, ARCHIVE_MANIFEST_SCHEMA_VERSION } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import { verifyArchiveTimestampTokens } from './archive-timestamp-verification.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FINGERPRINT = 'aaaabbbbccccddddeeeeffff';

function manifest(policyMode: ManifestPolicyMode): ArchiveManifest {
  return {
    schemaVersion: ARCHIVE_MANIFEST_SCHEMA_VERSION,
    layoutVersion: ARCHIVE_LAYOUT_VERSION,
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: SESSION_ID,
    fingerprint: FINGERPRINT,
    policyMode,
    profileId: 'baseline',
    discoveryDigest: null,
    auditChainHead: 'genesis',
    auditEventCount: 0,
    includedFiles: [],
    fileDigests: {},
    contentDigest: '',
  };
}

function stampedEvent(): AuditEvent {
  return {
    id: 'evt-1',
    sessionId: SESSION_ID,
    phase: 'COMPLETE',
    event: 'lifecycle:session_completed',
    timestamp: '2026-01-01T00:00:00.000Z',
    actor: 'machine',
    detail: {},
    timestampEvidence: {
      status: 'tsa_stamped',
      source: 'tsa',
      resolvedAt: '2026-01-01T00:00:00.000Z',
      tsa: {
        tokenDerBase64: Buffer.from('timestamp token').toString('base64'),
        receivedAt: '2026-01-01T00:00:00.000Z',
        messageImprint: 'a'.repeat(64),
        digestAlgorithm: 'sha256',
        verificationStatus: 'unchecked',
      },
    },
  } as unknown as AuditEvent;
}

/** Trusted policy state with enabled tsa_critical timestamp assurance. */
function tsaCriticalState(): ReturnType<typeof makeState> {
  return makeState('COMPLETE', {
    policySnapshot: {
      ...makeState('COMPLETE').policySnapshot,
      audit: {
        ...makeState('COMPLETE').policySnapshot.audit,
        timestampAssurance: {
          enabled: true,
          mode: 'tsa_critical',
          strict: true,
          criticalEvents: ['decision', 'lifecycle'],
          tsaUrl: 'https://tsa.example.test',
          trustAnchors: ['not a pem certificate'],
          ntpServers: ['pool.ntp.org'],
          ntpDriftThresholdMs: 30000,
          tsaTimeoutMs: 10000,
        },
      },
    },
  });
}

describe('verifyArchiveTimestampTokens', () => {
  it('warns when TSA evidence is present but trust anchors are missing in non-strict mode', async () => {
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [stampedEvent()],
      state: makeState('COMPLETE'),
      manifest: manifest('solo'),
      findings,
      strict: false,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_verification_failed',
        severity: 'warning',
        file: 'audit.jsonl',
      }),
    ]);
  });

  it('reports tsa_verification_failed when archived TSA token is invalid', async () => {
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [stampedEvent()],
      state: tsaCriticalState(),
      manifest: manifest('regulated'),
      findings,
      strict: true,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_verification_failed',
        severity: 'error',
        file: 'audit.jsonl',
      }),
    ]);
  });

  it('AR2: a regulated MANIFEST alone never drives error severity (trusted policy state only)', async () => {
    // Non-strict trusted policy: TSA evidence present, no trust anchors.
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [stampedEvent()],
      state: makeState('COMPLETE'),
      manifest: manifest('regulated'),
      findings,
      strict: false,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_verification_failed',
        severity: 'warning',
      }),
    ]);
  });

  it('AR2: strict trusted policy drives error severity even with a non-regulated manifest', async () => {
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [stampedEvent()],
      state: tsaCriticalState(),
      manifest: manifest('solo'),
      findings,
      strict: true,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_verification_failed',
        severity: 'error',
      }),
    ]);
  });

  it('a null tsa payload is not TSA evidence (no finding without anchors)', async () => {
    const event = {
      ...stampedEvent(),
      timestampEvidence: { ...stampedEvent().timestampEvidence, tsa: null },
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [event],
      state: makeState('COMPLETE'),
      manifest: manifest('solo'),
      findings,
      strict: false,
    });

    expect(findings).toEqual([]);
  });

  it('warns only when SOME event carries TSA evidence (binding is some, not every)', async () => {
    const plain = makeState('COMPLETE');
    const stamped = stampedEvent();
    const withoutTsa = {
      ...stamped,
      timestampEvidence: undefined,
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [withoutTsa, stamped],
      state: plain,
      manifest: manifest('solo'),
      findings,
      strict: false,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_verification_failed',
        severity: 'warning',
      }),
    ]);
  });

  it('emits nothing without anchors when NO event carries TSA evidence', async () => {
    const event = {
      ...stampedEvent(),
      timestampEvidence: undefined,
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [event],
      state: makeState('COMPLETE'),
      manifest: manifest('solo'),
      findings,
      strict: false,
    });

    expect(findings).toEqual([]);
  });

  it('internal-imprint events (empty token) are not external TSA evidence without anchors', async () => {
    // Sentinel contract: an empty tokenDerBase64 is the internal-imprint
    // model, not external TSA evidence. It must not trigger the
    // "evidence present but no trust anchors" diagnostic.
    const internalImprint = {
      ...stampedEvent(),
      timestampEvidence: {
        ...stampedEvent().timestampEvidence,
        tsa: { ...stampedEvent().timestampEvidence!.tsa!, tokenDerBase64: '' },
      },
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [internalImprint],
      state: makeState('COMPLETE'),
      manifest: manifest('solo'),
      findings,
      strict: false,
    });

    expect(findings).toEqual([]);
  });

  it('tsa_critical policy rejects internal-imprint evidence on a critical event', async () => {
    // Policy authority: tsa_critical REQUIRES an external TSA token for
    // critical events. Internal-imprint evidence (empty token) must be
    // reported as a dedicated assurance downgrade, not silently accepted.
    const internalImprint = {
      ...stampedEvent(),
      timestampEvidence: {
        ...stampedEvent().timestampEvidence,
        tsa: { ...stampedEvent().timestampEvidence!.tsa!, tokenDerBase64: '' },
      },
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [internalImprint],
      state: tsaCriticalState(),
      manifest: manifest('regulated'),
      findings,
      strict: true,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_token_required_by_policy',
        severity: 'error',
      }),
    ]);
  });

  it('tsa_critical policy rejects a critical event without any timestamp evidence', async () => {
    // The policy requirement is POSITIVE: no evidence at all is just as
    // unsatisfied as internal-imprint evidence.
    const withoutEvidence = {
      ...stampedEvent(),
      timestampEvidence: undefined,
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [withoutEvidence],
      state: tsaCriticalState(),
      manifest: manifest('regulated'),
      findings,
      strict: true,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_token_required_by_policy',
        severity: 'error',
      }),
    ]);
  });

  it('tsa_critical policy rejects ntp-only evidence on a critical event', async () => {
    // ntp_checked evidence carries no external TSA token and must not
    // satisfy the tsa_critical requirement.
    const ntpOnly = {
      ...stampedEvent(),
      timestampEvidence: {
        status: 'ntp_checked',
        source: 'ntp',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        ntp: { offsetMs: 10, server: 'pool.ntp.org', driftWarned: false },
      },
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [ntpOnly],
      state: tsaCriticalState(),
      manifest: manifest('regulated'),
      findings,
      strict: true,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_token_required_by_policy',
        severity: 'error',
      }),
    ]);
  });

  it('internal-imprint events (empty token) are never sent to the RFC 3161 verifier under a permissive policy', async () => {
    // Positive sentinel test: a policy that does NOT require external tokens
    // (ntp_check) treats the empty-token internal-imprint form as already
    // verified chain content — it is skipped, not sent to the verifier as a
    // broken RFC 3161 token.
    const state = makeState('COMPLETE', {
      policySnapshot: {
        ...makeState('COMPLETE').policySnapshot,
        audit: {
          ...makeState('COMPLETE').policySnapshot.audit,
          timestampAssurance: {
            enabled: true,
            mode: 'ntp_check',
            strict: true,
            criticalEvents: ['decision', 'lifecycle'],
            tsaUrl: 'https://tsa.example.test',
            trustAnchors: ['not a pem certificate'],
            ntpServers: ['pool.ntp.org'],
            ntpDriftThresholdMs: 30000,
            tsaTimeoutMs: 10000,
          },
        },
      },
    });
    const internalImprint = {
      ...stampedEvent(),
      timestampEvidence: {
        ...stampedEvent().timestampEvidence,
        tsa: { ...stampedEvent().timestampEvidence!.tsa!, tokenDerBase64: '' },
      },
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [internalImprint],
      state,
      manifest: manifest('regulated'),
      findings,
      strict: true,
    });

    expect(findings).toEqual([]);
  });
});
