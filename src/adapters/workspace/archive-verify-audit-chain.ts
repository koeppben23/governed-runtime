/**
 * @module adapters/workspace/archive-verify-audit-chain
 * @description Audit-chain verification stages: completeness anchor, artifact
 * binding, timestamp findings, and the synchronous chain/token verification
 * orchestration.
 *
 * @version v1
 */

import * as path from 'node:path';
import { readAuditTrail } from '../persistence-audit.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { verifyChain, getLastChainHash, type ChainVerification } from '../../audit/integrity.js';
import { logAuditChainVerificationFailure } from './archive-verify-logging.js';
import { verifyRegulatedCompletionCompleteness } from './archive-verify-regulated.js';
import { type ArchiveManifest, type ArchiveFinding } from '../../archive/types.js';
import {
  hasTimestampEvidence,
  isCurrentChainIntegrityFailure,
  isAuditFormatFailure,
  isDeferredTimestampReason,
  auditReadFailureFindingCode,
  timestampFindingCode,
} from './archive-verify-helpers.js';
import { isPolicyMode } from '../../state/policy-mode.js';
import { verifyArtifactBinding } from './archive-verify-artifact-binding.js';

// ─── Constants ────────────────────────────────────────────────────────────────

/** Hex prefix length for logging chain-head fingerprints (never the full hash material). */
const AUDIT_HEAD_LOG_PREFIX_LENGTH = 16;

// ─── Audit Chain Logging & Findings ───────────────────────────────────────────

function addAuditFormatFindings(chainResult: ChainVerification, findings: ArchiveFinding[]): void {
  if (chainResult.reason !== 'AUDIT_ENVELOPE_INVALID') return;
  findings.push({
    code: 'audit_chain_invalid_event',
    severity: 'error',
    message:
      'Audit chain contains records that violate the canonical audit-chain.v3 event ' +
      'envelope. Non-v3 assurance artifacts cannot be treated as verifiable evidence.',
    file: 'audit.jsonl',
  });
}

// ─── Policy Mode ──────────────────────────────────────────────────────────────

/**
 * Cross-check the unsigned manifest.policyMode against the integrity-covered
 * state mode. A mismatch is a tamper signal (e.g. flipping regulated→team to
 * weaken verification) and fails closed. Skipped when state is unresolvable —
 * that is already surfaced by state_missing/state_invalid.
 */
export function verifyManifestPolicyMode(
  manifest: ArchiveManifest,
  state: import('../../state/schema.js').SessionState | null,
  findings: ArchiveFinding[],
): void {
  const stateMode = state?.policySnapshot?.mode;
  if (!isPolicyMode(stateMode)) return;
  if (manifest.policyMode === stateMode) return;

  getAdapterLogger().error('archive', 'Manifest policy mode does not match governed state', {
    reason: 'manifest_policy_mode_mismatch',
    manifestMode: manifest.policyMode,
    stateMode,
  });
  findings.push({
    code: 'manifest_policy_mode_mismatch',
    severity: 'error',
    message: `Manifest policyMode '${manifest.policyMode}' does not match governed state mode '${stateMode}'`,
    file: 'archive-manifest.json',
  });
}

// ─── Audit Completeness ───────────────────────────────────────────────────────

/**
 * Verify the audit tail anchor (head + count) against the manifest.
 *
 * A truncated trail is still a valid hash-chain prefix, so chain verification
 * alone cannot detect a missing tail. The manifest anchor makes truncation
 * explicit (defense-in-depth above file_digest_mismatch).
 */
function verifyAuditCompleteness(
  manifest: ArchiveManifest,
  events: readonly Record<string, unknown>[],
  findings: ArchiveFinding[],
): void {
  const actualCount = events.length;
  const actualHead = getLastChainHash([...events]);
  if (actualCount === manifest.auditEventCount && actualHead === manifest.auditChainHead) {
    return;
  }

  getAdapterLogger().error('archive', 'Audit trail completeness anchor mismatch', {
    reason: 'audit_chain_truncated',
    expectedCount: manifest.auditEventCount,
    actualCount,
    expectedHead: manifest.auditChainHead.slice(0, AUDIT_HEAD_LOG_PREFIX_LENGTH),
    actualHead: actualHead.slice(0, AUDIT_HEAD_LOG_PREFIX_LENGTH),
  });
  findings.push({
    code: 'audit_chain_truncated',
    severity: 'error',
    message:
      `Audit trail does not match manifest anchor: expected ${manifest.auditEventCount} event(s), ` +
      `found ${actualCount}`,
    file: 'audit.jsonl',
  });
}

// ─── Timestamp Findings ───────────────────────────────────────────────────────

/**
 * Map a chain timestamp reason to the archive finding code (AC2): downgraded
 * evidence gets its own diagnostic code — a degraded status is never silently
 * folded into the generic unanchored bucket.
 */
function addTimestampMismatchFindings(
  chainResult: ReturnType<typeof verifyChain>,
  fatal: boolean,
  findings: ArchiveFinding[],
): void {
  if (
    !chainResult.valid &&
    !isCurrentChainIntegrityFailure(chainResult.reason) &&
    !isAuditFormatFailure(chainResult.reason) &&
    // Pending cryptographic verification is not a failure. The asynchronous
    // token verifier below is the single authority for the verdict, and
    // findings are append-only — emitting here would be unretractable.
    !isDeferredTimestampReason(chainResult.reason)
  ) {
    const code = timestampFindingCode(chainResult.reason);
    findings.push({
      code,
      severity: fatal ? 'error' : 'warning',
      message: `Timestamp verification failed (${chainResult.reason}): ${chainResult.totalEvents} total, ${chainResult.verifiedCount} verified`,
      file: 'audit.jsonl',
    });
  }
  if (chainResult.timestampMonotonicity && !chainResult.timestampMonotonicity.valid) {
    findings.push({
      code: 'timestamp_unanchored',
      severity: fatal ? 'error' : 'warning',
      message: `Timestamp monotonicity violation: ${chainResult.timestampMonotonicity.message}`,
      file: 'audit.jsonl',
    });
  }
}

function addEvidenceGapFindings(
  chainResult: ReturnType<typeof verifyChain>,
  fatal: boolean,
  findings: ArchiveFinding[],
): void {
  if (chainResult.missingTimestampEvidence.length > 0) {
    findings.push({
      code: 'timestamp_unanchored',
      severity: fatal ? 'error' : 'warning',
      message: `${chainResult.missingTimestampEvidence.length} critical event(s) lack timestamp assurance evidence (indices: ${chainResult.missingTimestampEvidence.join(', ')})`,
      file: 'audit.jsonl',
    });
  }
  if (chainResult.tsaImprintMismatches.length > 0) {
    findings.push({
      code: 'tsa_verification_failed',
      severity: fatal ? 'error' : 'warning',
      message: `${chainResult.tsaImprintMismatches.length} event(s) have TSA messageImprint mismatch (indices: ${chainResult.tsaImprintMismatches.join(', ')})`,
      file: 'audit.jsonl',
    });
  }
}

/**
 * Project a chain verification result into archive findings.
 *
 * Exported for direct testing: this projection is where a DEFERRED
 * cryptographic verification must not become a terminal failure, and archive
 * findings are append-only, so a mistake here cannot be corrected by the
 * asynchronous verifier that runs afterwards.
 */
export function addTimestampFindings(
  chainResult: ReturnType<typeof verifyChain>,
  timestampFailuresAreFatal: boolean,
  findings: ArchiveFinding[],
): void {
  if (!chainResult.valid && isCurrentChainIntegrityFailure(chainResult.reason)) {
    findings.push({
      code: 'audit_chain_invalid',
      severity: 'error',
      message: `Audit chain verification failed (${chainResult.reason}): ${chainResult.totalEvents} total, ${chainResult.verifiedCount} verified`,
      file: 'audit.jsonl',
    });
  }
  addTimestampMismatchFindings(chainResult, timestampFailuresAreFatal, findings);
  addEvidenceGapFindings(chainResult, timestampFailuresAreFatal, findings);
}

// ─── Chain Verification ───────────────────────────────────────────────────────

async function verifyTimestampChain(
  events: Awaited<ReturnType<typeof readAuditTrail>>,
  state: import('../../state/schema.js').SessionState | null,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  strict: boolean,
): Promise<void> {
  const timestampPolicy = state?.policySnapshot.audit.timestampAssurance;
  const strictTimestamps = events.some(hasTimestampEvidence) || timestampPolicy?.enabled === true;
  const timestampFailuresAreFatal = strict || timestampPolicy?.strict === true;
  const chainResult = verifyChain(events, {
    strictTimestamps,
    ...(state ? { expectedFlowguardSessionId: state.flowguardSessionId } : {}),
  });
  logAuditChainVerificationFailure(chainResult);
  addAuditFormatFindings(chainResult, findings);
  addTimestampFindings(chainResult, timestampFailuresAreFatal, findings);

  const { verifyArchiveTimestampTokens } = await import('./archive-timestamp-verification.js');
  // Single fatality authority: archive-mode strictness OR the explicit
  // timestamp assurance policy — the token layer must not re-derive
  // strictness from the archive mode alone.
  await verifyArchiveTimestampTokens({
    events,
    state,
    manifest,
    findings,
    fatal: timestampFailuresAreFatal,
  });
}

export async function verifyAuditChainIntegrity(
  archiveRoot: string,
  manifest: ArchiveManifest,
  findings: ArchiveFinding[],
  state: import('../../state/schema.js').SessionState | null,
  strict: boolean,
): Promise<void> {
  try {
    const events = await readAuditTrail(path.join(archiveRoot, 'audit'));
    verifyAuditCompleteness(manifest, events, findings);
    verifyRegulatedCompletionCompleteness(state, events, findings);

    await verifyArtifactBinding(archiveRoot, manifest, events, findings);

    if (events.length > 0) {
      await verifyTimestampChain(events, state, manifest, findings, strict);
    }
  } catch (error) {
    // Fail closed in every mode: malformed or non-v3 audit records are never
    // silently tolerated just because verification is non-strict.
    findings.push({
      code: auditReadFailureFindingCode(error),
      severity: 'error',
      message: `Audit chain verification could not read audit.jsonl: ${
        error instanceof Error ? error.message : String(error)
      }`,
      file: 'audit.jsonl',
    });
  }
}
