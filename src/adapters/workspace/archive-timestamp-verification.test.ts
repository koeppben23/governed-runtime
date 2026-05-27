import { describe, expect, it } from 'vitest';
import { makeState } from '../../__fixtures__.js';
import type { ArchiveFinding, ArchiveManifest } from '../../archive/types.js';
import type { AuditEvent } from '../../state/evidence.js';
import { verifyArchiveTimestampTokens } from './archive-timestamp-verification.js';

const SESSION_ID = 'aaaaaaaa-0000-4000-8000-000000000001';
const FINGERPRINT = 'aaaabbbbccccddddeeeeffff';

function manifest(policyMode: string): ArchiveManifest {
  return {
    schemaVersion: 'archive-manifest.v1',
    createdAt: '2026-01-01T00:00:00.000Z',
    sessionId: SESSION_ID,
    fingerprint: FINGERPRINT,
    policyMode,
    profileId: 'baseline',
    discoveryDigest: null,
    includedFiles: [],
    fileDigests: {},
    contentDigest: '',
  };
}

describe('verifyArchiveTimestampTokens', () => {
  it('warns when TSA evidence is present but trust anchors are missing in non-strict mode', async () => {
    const event = {
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
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [event],
      state: makeState('COMPLETE'),
      manifest: manifest('solo'),
      findings,
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
    const event = {
      id: 'evt-1',
      sessionId: SESSION_ID,
      phase: 'COMPLETE',
      event: 'lifecycle:session_completed',
      timestamp: '2026-01-01T00:00:00.000Z',
      actor: 'machine',
      detail: {},
      canonicalEventDigest: 'a'.repeat(64),
      timestampEvidence: {
        status: 'tsa_stamped',
        source: 'tsa',
        resolvedAt: '2026-01-01T00:00:00.000Z',
        tsa: {
          tokenDerBase64: Buffer.from('not a timestamp token').toString('base64'),
          receivedAt: '2026-01-01T00:00:00.000Z',
          messageImprint: 'a'.repeat(64),
          digestAlgorithm: 'sha256',
          verificationStatus: 'unchecked',
        },
      },
    } as unknown as AuditEvent;
    const findings: ArchiveFinding[] = [];

    await verifyArchiveTimestampTokens({
      events: [event],
      state,
      manifest: manifest('regulated'),
      findings,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        code: 'tsa_verification_failed',
        severity: 'error',
        file: 'audit.jsonl',
      }),
    ]);
  });
});
