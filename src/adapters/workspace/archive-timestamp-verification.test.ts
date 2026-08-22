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
    const state = makeState('COMPLETE', {
      policySnapshot: {
        ...makeState('COMPLETE').policySnapshot,
        mode: 'regulated',
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
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [stampedEvent()],
      state,
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
    const state = makeState('COMPLETE', {
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
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [stampedEvent()],
      state,
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
});
