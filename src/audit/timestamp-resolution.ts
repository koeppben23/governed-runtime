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
 * - strict is a policy-configurable field (TimestampAssurancePolicy.strict)
 *   but is not read by resolveTimestampEvidence in this module.
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

  if (!policy.enabled || policy.mode === 'local_only') {
    return localTimestampResult(input.localTimestamp);
  }

  if (policy.mode === 'ntp_check') {
    return ntpTimestampResult(input.ntpResult, input.localTimestamp);
  }

  if (policy.mode === 'tsa_critical') {
    return resolveTsaCriticalTimestamp(input);
  }

  return localTimestampResult(input.localTimestamp);
}

function localTimestampResult(resolvedAt: string): TimestampResolutionResult {
  return { evidence: { status: 'local', source: 'local_clock', resolvedAt } };
}

function ntpEvidence(ntp: NtpCheckResult | undefined): TimestampEvidence['ntp'] {
  return ntp && !ntp.error
    ? { offsetMs: ntp.offsetMs, server: ntp.server, driftWarned: ntp.driftWarned }
    : undefined;
}

function ntpTimestampResult(
  ntp: NtpCheckResult | undefined,
  resolvedAt: string,
): TimestampResolutionResult {
  return {
    evidence: {
      status: 'ntp_checked',
      source: ntp && !ntp.error ? 'ntp' : 'local_clock',
      ntp: ntpEvidence(ntp),
      warning: ntp?.error,
      resolvedAt,
    },
  };
}

async function resolveTsaCriticalTimestamp(
  input: TimestampResolutionInput,
): Promise<TimestampResolutionResult> {
  if (!isCriticalEvent(input.eventKind, input.policy)) {
    return ntpTimestampResult(input.ntpResult, input.localTimestamp);
  }
  if (!input.tsaProvider) return tsaProviderUnavailableResult(input);
  try {
    const tsaResponse = await requestTimestamp(input);
    const verification = await verifyTimestampResponse(input, tsaResponse.tokenDerBase64);
    return verification?.status === 'invalid'
      ? invalidTsaResult(input, tsaResponse, verification.reason ?? 'invalid_timestamp_token')
      : stampedTsaResult(input, tsaResponse, verification);
  } catch {
    return tsaRequestFailedResult(input);
  }
}

function tsaProviderUnavailableResult(input: TimestampResolutionInput): TimestampResolutionResult {
  const warnMsg = 'TSA provider unavailable for tsa_critical mode';
  return {
    evidence: {
      status: 'tsa_failed',
      source: 'local_clock',
      ntp: ntpEvidence(input.ntpResult),
      warning: [warnMsg, input.ntpResult?.error].filter(Boolean).join('; ') || warnMsg,
      resolvedAt: input.localTimestamp,
    },
    error: warnMsg,
  };
}

async function requestTimestamp(input: TimestampResolutionInput) {
  return input.tsaProvider!.requestTimestamp({
    digest: canonicalDigestToUint8Array(input.canonicalEventDigest),
    digestAlgorithm: 'sha256',
    tsaUrl: input.policy.tsaUrl ?? '',
    timeoutMs: input.policy.tsaTimeoutMs ?? DEFAULT_TIMESTAMP_ASSURANCE.tsaTimeoutMs,
  });
}

async function verifyTimestampResponse(input: TimestampResolutionInput, tokenDerBase64: string) {
  if (!input.tsaVerifier) return undefined;
  // Stamp-time verification only ever requests SHA-256 imprints from the TSA,
  // so only the SHA-256 expected digest exists here. The sha384/sha512 slots
  // are deliberately EMPTY: a token declaring a different imprint algorithm
  // fails the constant-time comparison closed (length folding) instead of
  // being compared against an arbitrary placeholder.
  return input.tsaVerifier.verifyToken({
    tokenDerBase64,
    expectedDigests: {
      sha256: canonicalDigestToUint8Array(input.canonicalEventDigest),
      sha384: new Uint8Array(0),
      sha512: new Uint8Array(0),
    },
    trustAnchors: [...(input.policy.trustAnchors ?? [])],
  });
}

function invalidTsaResult(
  input: TimestampResolutionInput,
  tsaResponse: Awaited<ReturnType<TimestampAuthorityProvider['requestTimestamp']>>,
  reason: string,
): TimestampResolutionResult {
  return {
    evidence: {
      status: 'tsa_stamped',
      source: 'tsa',
      ntp: ntpEvidence(input.ntpResult),
      tsa: {
        tokenDerBase64: tsaResponse.tokenDerBase64,
        receivedAt: tsaResponse.receivedAt,
        messageImprint: input.canonicalEventDigest,
        digestAlgorithm: 'sha256',
        verificationStatus: 'invalid',
        verificationReason: reason,
      },
      warning: [reason, input.ntpResult?.error].filter(Boolean).join('; '),
      resolvedAt: input.localTimestamp,
    },
    error: reason,
  };
}

function stampedTsaResult(
  input: TimestampResolutionInput,
  tsaResponse: Awaited<ReturnType<TimestampAuthorityProvider['requestTimestamp']>>,
  verification: Awaited<ReturnType<TimestampVerifier['verifyToken']>> | undefined,
): TimestampResolutionResult {
  return {
    evidence: {
      status: 'tsa_stamped',
      source: 'tsa',
      ntp: ntpEvidence(input.ntpResult),
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
      warning: input.ntpResult?.error,
      resolvedAt: input.localTimestamp,
    },
  };
}

function tsaRequestFailedResult(input: TimestampResolutionInput): TimestampResolutionResult {
  return {
    evidence: {
      status: 'tsa_failed',
      source: 'local_clock',
      ntp: ntpEvidence(input.ntpResult),
      warning: `TSA unreachable: ${input.policy.tsaUrl ?? 'unconfigured'}${input.ntpResult?.error ? '; NTP: ' + input.ntpResult.error : ''}`,
      resolvedAt: input.localTimestamp,
    },
    error: 'TSA request failed',
  };
}
