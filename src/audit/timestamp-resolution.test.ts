import { describe, it, expect } from 'vitest';
import { resolveTimestampEvidence } from './timestamp-resolution.js';
import { MockTimestampAuthorityProvider } from './tsa-provider.js';
import type { TimestampVerifier } from './tsa-provider.js';
import type { TimestampAssurancePolicy } from '../config/policy-types.js';

const LOCAL_POLICY: TimestampAssurancePolicy = {
  enabled: false,
  mode: 'local_only',
  strict: false,
  criticalEvents: ['decision', 'lifecycle'],
  ntpServers: ['pool.ntp.org'],
  ntpDriftThresholdMs: 30000,
  tsaTimeoutMs: 10000,
};

const NTP_POLICY: TimestampAssurancePolicy = {
  ...LOCAL_POLICY,
  enabled: true,
  mode: 'ntp_check',
};

const TSA_CRITICAL_POLICY: TimestampAssurancePolicy = {
  ...LOCAL_POLICY,
  enabled: true,
  mode: 'tsa_critical',
  tsaUrl: 'https://tsa.example.com',
};

const DIGEST = 'a'.repeat(64);
const NOW = '2026-01-01T00:00:00.000Z';

describe('resolveTimestampEvidence', () => {
  describe('disabled / local_only', () => {
    it('returns local when disabled', async () => {
      const result = await resolveTimestampEvidence({
        policy: { ...LOCAL_POLICY, enabled: false },
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
      });
      expect(result.evidence.status).toBe('local');
      expect(result.evidence.source).toBe('local_clock');
    });

    it('returns local when mode is local_only even if enabled', async () => {
      const result = await resolveTimestampEvidence({
        policy: { ...LOCAL_POLICY, enabled: true, mode: 'local_only' },
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
      });
      expect(result.evidence.status).toBe('local');
      expect(result.evidence.source).toBe('local_clock');
    });
  });

  describe('ntp_check mode', () => {
    it('returns ntp_checked without NTP result', async () => {
      const result = await resolveTimestampEvidence({
        policy: NTP_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'tool_call',
        localTimestamp: NOW,
      });
      expect(result.evidence.status).toBe('ntp_checked');
      expect(result.evidence.source).toBe('local_clock');
    });

    it('returns ntp_checked with NTP result', async () => {
      const result = await resolveTimestampEvidence({
        policy: NTP_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'tool_call',
        localTimestamp: NOW,
        ntpResult: { offsetMs: 100, server: 'pool.ntp.org', driftWarned: false, roundTripMs: 50 },
      });
      expect(result.evidence.status).toBe('ntp_checked');
      expect(result.evidence.source).toBe('ntp');
      expect(result.evidence.ntp).toBeDefined();
      expect(result.evidence.ntp!.offsetMs).toBe(100);
    });

    it('flags NTP drift warning', async () => {
      const result = await resolveTimestampEvidence({
        policy: NTP_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'tool_call',
        localTimestamp: NOW,
        ntpResult: { offsetMs: 50000, server: 'pool.ntp.org', driftWarned: true, roundTripMs: 50 },
      });
      expect(result.evidence.ntp!.driftWarned).toBe(true);
    });

    it('includes NTP error as warning', async () => {
      const result = await resolveTimestampEvidence({
        policy: NTP_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'tool_call',
        localTimestamp: NOW,
        ntpResult: {
          offsetMs: 0,
          server: 'pool.ntp.org',
          driftWarned: false,
          roundTripMs: 0,
          error: 'NTP unreachable',
        },
      });
      expect(result.evidence.warning).toContain('NTP unreachable');
    });
  });

  describe('tsa_critical mode', () => {
    it('non-critical events get ntp_checked', async () => {
      const result = await resolveTimestampEvidence({
        policy: TSA_CRITICAL_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'tool_call',
        localTimestamp: NOW,
      });
      expect(result.evidence.status).toBe('ntp_checked');
    });

    it('critical decision events get TSA stamp from provider', async () => {
      const provider = new MockTimestampAuthorityProvider();
      const result = await resolveTimestampEvidence({
        policy: TSA_CRITICAL_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
        tsaProvider: provider,
      });
      expect(result.evidence.status).toBe('tsa_stamped');
      expect(result.evidence.source).toBe('tsa');
      expect(result.evidence.tsa).toBeDefined();
      expect(result.evidence.tsa!.verificationStatus).toBe('unchecked');
    });

    it('critical lifecycle events get TSA stamp', async () => {
      const provider = new MockTimestampAuthorityProvider();
      const result = await resolveTimestampEvidence({
        policy: TSA_CRITICAL_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'lifecycle',
        localTimestamp: NOW,
        tsaProvider: provider,
      });
      expect(result.evidence.status).toBe('tsa_stamped');
    });

    it('critical events without provider fall back to tsa_failed', async () => {
      const result = await resolveTimestampEvidence({
        policy: TSA_CRITICAL_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
      });
      expect(result.evidence.status).toBe('tsa_failed');
      expect(result.evidence.source).toBe('local_clock');
      expect(result.evidence.warning).toContain('provider unavailable');
    });

    it('TSA failure returns tsa_failed evidence', async () => {
      const provider = new MockTimestampAuthorityProvider({ simulateFailure: true });
      const result = await resolveTimestampEvidence({
        policy: TSA_CRITICAL_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
        tsaProvider: provider,
      });
      expect(result.evidence.status).toBe('tsa_failed');
      expect(result.evidence.source).toBe('local_clock');
      expect(result.error).toBe('TSA request failed');
    });

    it('TSA failure includes warning message', async () => {
      const provider = new MockTimestampAuthorityProvider({ simulateFailure: true });
      const result = await resolveTimestampEvidence({
        policy: TSA_CRITICAL_POLICY,
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
        tsaProvider: provider,
      });
      expect(result.evidence.warning).toContain('TSA unreachable');
    });

    it('strict: true returns explicit error for caller enforcement on TSA failure', async () => {
      const strictPolicy: TimestampAssurancePolicy = {
        ...TSA_CRITICAL_POLICY,
        strict: true,
      };
      const provider = new MockTimestampAuthorityProvider({ simulateFailure: true });
      const result = await resolveTimestampEvidence({
        policy: strictPolicy,
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
        tsaProvider: provider,
      });
      expect(result.evidence.status).toBe('tsa_failed');
      expect(result.error).toBe('TSA request failed');
    });

    it('verified TSA token keeps stamped status with valid verification detail', async () => {
      const verifier: TimestampVerifier = {
        verifyToken: async () => ({
          status: 'valid',
          tsaTimestamp: NOW,
          policyOid: '1.2.3.4',
          serialNumber: '01',
          signerSubject: 'CN=Test TSA',
        }),
      };
      const result = await resolveTimestampEvidence({
        policy: { ...TSA_CRITICAL_POLICY, trustAnchors: ['pem'] },
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
        tsaProvider: new MockTimestampAuthorityProvider(),
        tsaVerifier: verifier,
      });

      expect(result.evidence.status).toBe('tsa_stamped');
      expect(result.evidence.tsa?.verificationStatus).toBe('valid');
      expect(result.evidence.tsa?.policyOid).toBe('1.2.3.4');
    });

    it('invalid TSA token records invalid verification reason fail-closed', async () => {
      const verifier: TimestampVerifier = {
        verifyToken: async () => ({ status: 'invalid', reason: 'digest_mismatch' }),
      };
      const result = await resolveTimestampEvidence({
        policy: { ...TSA_CRITICAL_POLICY, trustAnchors: ['pem'] },
        canonicalEventDigest: DIGEST,
        eventKind: 'decision',
        localTimestamp: NOW,
        tsaProvider: new MockTimestampAuthorityProvider(),
        tsaVerifier: verifier,
      });

      expect(result.evidence.status).toBe('tsa_stamped');
      expect(result.evidence.tsa?.verificationStatus).toBe('invalid');
      expect(result.evidence.tsa?.verificationReason).toBe('digest_mismatch');
      expect(result.error).toBe('digest_mismatch');
    });
  });
});
