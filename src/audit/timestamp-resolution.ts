/**
 * @module audit/timestamp-resolution
 * @description Timestamp evidence resolution orchestrator.
 *
 * Determines the timestamp assurance evidence for an audit event based on:
 * - Policy configuration (mode, strict, critical events)
 * - Event criticality (decision/lifecycle = critical, rest = standard)
 * - TSA provider availability
 * - NTP clock check results
 *
 * Fail-closed invariants:
 * - TSA unreachable → status:'tsa_failed', event still recorded (audit gap is worse)
 * - In Slice 1, strict is always false. Strict ERROR transition is Slice 2.
 * - No silent fallback hides TSA failure.
 *
 * @version v1
 */

import type { TimestampAssurancePolicy } from '../config/policy-types.js';
import { DEFAULT_TIMESTAMP_ASSURANCE } from './timestamp-types.js';
import type { TimestampAuthorityProvider, TimestampVerifier } from './tsa-provider.js';
import type { NtpCheckResult } from './ntp-check.js';
import type { TimestampEvidence } from './timestamp-types.js';
import { canonicalDigestToUint8Array } from './timestamp-verification.js';

export interface TimestampResolutionInput {
  readonly policy: TimestampAssurancePolicy;
  readonly canonicalEventDigest: string;
  readonly eventKind: string;
  readonly localTimestamp: string;
  readonly tsaProvider?: TimestampAuthorityProvider;
  readonly tsaVerifier?: TimestampVerifier;
  readonly ntpResult?: NtpCheckResult;
}

export interface TimestampResolutionResult {
  readonly evidence: TimestampEvidence;
  readonly error?: string;
}

function isCriticalEvent(eventKind: string, policy: TimestampAssurancePolicy): boolean {
  return policy.criticalEvents.includes(eventKind);
}

/**
 * Resolve timestamp assurance evidence for an audit event.
 *
 * Decision logic:
 *   disabled/local_only → local
 *   ntp_check → NTP-validated
 *   tsa_critical + critical → TSA stamp
 *   tsa_critical + non-critical → NTP-validated
 *
 * TSA failures result in tsa_failed evidence (never silent).
 */
export async function resolveTimestampEvidence(
  input: TimestampResolutionInput,
): Promise<TimestampResolutionResult> {
  const policy = input.policy;
  const now = input.localTimestamp;
  const eventKind = input.eventKind;

  if (!policy.enabled || policy.mode === 'local_only') {
    return {
      evidence: {
        status: 'local',
        source: 'local_clock',
        resolvedAt: now,
      },
    };
  }

  const ntp = input.ntpResult;

  if (policy.mode === 'ntp_check') {
    return {
      evidence: {
        status: 'ntp_checked',
        source: ntp && !ntp.error ? 'ntp' : 'local_clock',
        ntp:
          ntp && !ntp.error
            ? { offsetMs: ntp.offsetMs, server: ntp.server, driftWarned: ntp.driftWarned }
            : undefined,
        warning: ntp?.error,
        resolvedAt: now,
      },
    };
  }

  if (policy.mode === 'tsa_critical') {
    const ntpEvidence =
      ntp && !ntp.error
        ? { offsetMs: ntp.offsetMs, server: ntp.server, driftWarned: ntp.driftWarned }
        : undefined;

    if (!isCriticalEvent(eventKind, policy)) {
      return {
        evidence: {
          status: 'ntp_checked',
          source: ntp && !ntp.error ? 'ntp' : 'local_clock',
          ntp: ntpEvidence,
          warning: ntp?.error,
          resolvedAt: now,
        },
      };
    }

    if (!input.tsaProvider) {
      const warnMsg = 'TSA provider unavailable for tsa_critical mode';
      return {
        evidence: {
          status: 'tsa_failed',
          source: 'local_clock',
          ntp: ntpEvidence,
          warning: [warnMsg, ntp?.error].filter(Boolean).join('; ') || warnMsg,
          resolvedAt: now,
        },
        error: warnMsg,
      };
    }

    try {
      const tsaResponse = await input.tsaProvider.requestTimestamp({
        digest: canonicalDigestToUint8Array(input.canonicalEventDigest),
        digestAlgorithm: 'sha256',
        tsaUrl: policy.tsaUrl ?? '',
        timeoutMs: policy.tsaTimeoutMs ?? DEFAULT_TIMESTAMP_ASSURANCE.tsaTimeoutMs,
      });

      const verification = input.tsaVerifier
        ? await input.tsaVerifier.verifyToken({
            tokenDerBase64: tsaResponse.tokenDerBase64,
            expectedDigest: canonicalDigestToUint8Array(input.canonicalEventDigest),
            digestAlgorithm: 'sha256',
            trustAnchors: [...(policy.trustAnchors ?? [])],
          })
        : undefined;

      if (verification?.status === 'invalid') {
        const reason = verification.reason ?? 'invalid_timestamp_token';
        return {
          evidence: {
            status: 'tsa_stamped',
            source: 'tsa',
            ntp: ntpEvidence,
            tsa: {
              tokenDerBase64: tsaResponse.tokenDerBase64,
              receivedAt: tsaResponse.receivedAt,
              messageImprint: input.canonicalEventDigest,
              digestAlgorithm: 'sha256',
              verificationStatus: 'invalid',
              verificationReason: reason,
            },
            warning: [reason, ntp?.error].filter(Boolean).join('; '),
            resolvedAt: now,
          },
          error: reason,
        };
      }

      return {
        evidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          ntp: ntpEvidence,
          tsa: {
            tokenDerBase64: tsaResponse.tokenDerBase64,
            receivedAt: tsaResponse.receivedAt,
            messageImprint: input.canonicalEventDigest,
            digestAlgorithm: 'sha256',
            verificationStatus: verification?.status ?? 'unchecked',
            policyOid: verification?.policyOid,
            serialNumber: verification?.serialNumber,
            tsaTimestamp: verification?.tsaTimestamp,
            signerSubject: verification?.signerSubject,
          },
          warning: ntp?.error,
          resolvedAt: now,
        },
      };
    } catch {
      return {
        evidence: {
          status: 'tsa_failed',
          source: 'local_clock',
          ntp: ntpEvidence,
          warning: `TSA unreachable: ${input.policy.tsaUrl ?? 'unconfigured'}${ntp?.error ? '; NTP: ' + ntp.error : ''}`,
          resolvedAt: now,
        },
        error: 'TSA request failed',
      };
    }
  }

  return {
    evidence: {
      status: 'local',
      source: 'local_clock',
      resolvedAt: now,
    },
  };
}
