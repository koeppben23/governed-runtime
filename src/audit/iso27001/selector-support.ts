/**
 * @module audit/iso27001/selector-support
 * @description Shared reference builders, result constructors, and attempt
 * helpers for selector resolution. Split out of `selector-resolve.ts` to keep
 * both within the file-size budget.
 *
 * @version v1
 */

import {
  classifyValidationDisposition,
  type ValidationAttempt,
} from '../../state/evidence-validation.js';
import type { VerifiedEvidenceSnapshot } from './evidence.js';
import {
  AUDIT_MEMBER,
  STATE_MEMBER,
  type EvidenceRef,
  type EvidenceSelector,
  type Iso27001FindingCode,
  type SelectorFinding,
  type SelectorResolution,
  type SelectorStatus,
} from './selectors.js';

// ─── Reference Helpers ────────────────────────────────────────────────────────

export function baseRef(snapshot: VerifiedEvidenceSnapshot): EvidenceRef {
  return {
    source: 'state',
    sessionId: snapshot.sessionId,
    flowguardSessionId: snapshot.state.flowguardSessionId,
    fingerprint: snapshot.fingerprint,
    member: null,
    memberSha256: null,
    planVersion: null,
    planDigest: null,
    implementationId: null,
    implementationDigest: null,
    policyHash: null,
    policyHashVersion: null,
    checkId: null,
    attemptId: null,
    assertionProviderId: null,
    assertionLocalId: null,
    actorIdDigest: null,
    actorSource: null,
    actorAssurance: null,
    decisionId: null,
    exportedPackageSha256: snapshot.packageSha256,
    manifestContentDigest: snapshot.manifestContentDigest,
    occurredAt: null,
  };
}

export function stateRef(snapshot: VerifiedEvidenceSnapshot): EvidenceRef {
  const ref = baseRef(snapshot);
  const memberSha = snapshot.fileDigests[STATE_MEMBER] ?? null;
  return { ...ref, member: STATE_MEMBER, memberSha256: memberSha };
}

export function auditRef(snapshot: VerifiedEvidenceSnapshot): EvidenceRef {
  const ref = baseRef(snapshot);
  const memberSha = snapshot.fileDigests[AUDIT_MEMBER] ?? null;
  return { ...ref, source: 'audit', member: AUDIT_MEMBER, memberSha256: memberSha };
}

export function planFields(snapshot: VerifiedEvidenceSnapshot, ref: EvidenceRef): EvidenceRef {
  const plan = snapshot.state.plan;
  if (plan === null) return ref;
  return { ...ref, planVersion: plan.current.planVersion, planDigest: plan.current.digest };
}

function implementationFields(snapshot: VerifiedEvidenceSnapshot, ref: EvidenceRef): EvidenceRef {
  const implementation = snapshot.state.implementation;
  if (implementation === null) return ref;
  return {
    ...ref,
    implementationId: implementation.implementationId,
    implementationDigest: implementation.digest,
  };
}

// ─── Resolution Result Helpers ────────────────────────────────────────────────

function resolution(
  selector: EvidenceSelector,
  status: SelectorStatus,
  evidence: EvidenceRef[],
  findings: SelectorFinding[] = [],
): SelectorResolution {
  return { selector, status, findings, evidence };
}

export function verified(
  selector: EvidenceSelector,
  evidence: EvidenceRef[],
  findings: SelectorFinding[] = [],
): SelectorResolution {
  return resolution(selector, 'EVIDENCE_LINKED_VERIFIED', evidence, findings);
}

export function presentUnverified(
  selector: EvidenceSelector,
  code: Iso27001FindingCode,
  detail: string | null = null,
  evidence: EvidenceRef[] = [],
): SelectorResolution {
  return resolution(selector, 'EVIDENCE_PRESENT_UNVERIFIED', evidence, [{ code, detail }]);
}

export function missing(
  selector: EvidenceSelector,
  code: Iso27001FindingCode,
  detail: string | null = null,
  evidence: EvidenceRef[] = [],
): SelectorResolution {
  return resolution(selector, 'EVIDENCE_MISSING', evidence, [{ code, detail }]);
}

export function notVerified(
  selector: EvidenceSelector,
  code: Iso27001FindingCode,
  detail: string | null = null,
  evidence: EvidenceRef[] = [],
): SelectorResolution {
  return resolution(selector, 'NOT_VERIFIED', evidence, [{ code, detail }]);
}

// ─── Attempt Resolution ───────────────────────────────────────────────────────

export type ImplementationAttempt = Extract<ValidationAttempt, { scope: 'implementation' }>;

/**
 * Latest post-implementation attempt for `checkId` bound to the current
 * implementation digest. "Latest" is fail-closed: a later failing or blocked
 * attempt of the same check can never be shadowed by an earlier pass.
 */
function latestImplementationAttempt(
  snapshot: VerifiedEvidenceSnapshot,
  checkId: string,
): ImplementationAttempt | null {
  const implementation = snapshot.state.implementation;
  if (implementation === null) return null;
  const matching = snapshot.state.validationAttempts.filter(
    (attempt): attempt is ImplementationAttempt =>
      attempt.scope === 'implementation' &&
      attempt.implementationDigest === implementation.digest &&
      attempt.result.checkId === checkId,
  );
  return matching.at(-1) ?? null;
}

/** Canonical disposition through the shared classifier (exact optional props). */
function dispositionOf(
  result: ValidationAttempt['result'],
): ReturnType<typeof classifyValidationDisposition> {
  return classifyValidationDisposition({
    passed: result.passed,
    outcome: result.outcome,
    timedOut: result.timedOut,
    exitCode: result.exitCode,
    ...(result.assertionExtraction !== undefined
      ? { assertionExtraction: { status: result.assertionExtraction.status } }
      : {}),
  });
}

type AttemptOutcome =
  | { readonly kind: 'missing' }
  | { readonly kind: 'failed'; readonly attempt: ImplementationAttempt }
  | { readonly kind: 'blocked'; readonly attempt: ImplementationAttempt }
  | { readonly kind: 'supported'; readonly attempt: ImplementationAttempt };

export function attemptDisposition(
  snapshot: VerifiedEvidenceSnapshot,
  checkId: string,
): AttemptOutcome {
  const attempt = latestImplementationAttempt(snapshot, checkId);
  if (attempt === null) return { kind: 'missing' };
  const disposition = dispositionOf(attempt.result);
  if (disposition === 'supported' && attempt.result.timedOut === false) {
    return { kind: 'supported', attempt };
  }
  return { kind: disposition === 'artifact_failure' ? 'failed' : 'blocked', attempt };
}

export function attemptRef(
  snapshot: VerifiedEvidenceSnapshot,
  attempt: ImplementationAttempt,
  overrides: Partial<EvidenceRef>,
): EvidenceRef {
  const ref = implementationFields(snapshot, stateRef(snapshot));
  return {
    ...ref,
    checkId: attempt.result.checkId,
    attemptId: attempt.attemptId,
    occurredAt: attempt.result.executedAt,
    ...overrides,
  };
}

/** Implementation-bound state reference (no diff member). */
export function attemptBaseRef(snapshot: VerifiedEvidenceSnapshot): EvidenceRef {
  return implementationFields(snapshot, stateRef(snapshot));
}
