/**
 * @module presentation/reason-copy
 * @description Canonical human copy for migrated reason codes.
 *
 * Single authority for human-authored copy (`headline` + `explanation`) and
 * the authoritative `impact` classification for migrated reason codes.
 *
 * A code is "migrated" exactly when it has an entry in {@link REASON_COPY}:
 * - The projection replaces the registry-verbatim interpolated message with
 *   the context-free `headline` on the default human surface.
 * - The interpolated registry message is preserved as the projection's
 *   `canonicalMessage` (the diagnostic surface must never lose it).
 * - `impact` is derived ONLY from this table — never from the technical
 *   `BlockedCategory` taxonomy, which is an orthogonal dimension.
 *
 * Guardrails:
 * - Copy is English-only and context-free (no `{placeholder}` interpolation).
 * - Every code here MUST be registered in the canonical reason registry
 *   (enforced by `reason-copy.test.ts`).
 * - The projection MUST NOT introduce a parallel migrated set: the copy table
 *   is the single source of truth (enforced by the architecture SSOT test).
 * - Migrating a code is an explicit, reviewed decision — coverage grows
 *   deliberately, code by code.
 *
 * @version v1
 */

import type { UserImpact } from './human-projection.js';

/** Human-authored copy entry for one migrated reason code. */
export interface MigratedReasonCopy {
  readonly code: string;
  readonly impact: UserImpact;
  readonly headline: string;
  readonly explanation: string;
}

/** Canonical copy table — the single migrated-reason-code authority. */
export const REASON_COPY: readonly MigratedReasonCopy[] = [
  // ─── Validation evidence (#400) ───────────────────────────────────────────
  {
    code: 'VALIDATION_EVIDENCE_REQUIRED',
    impact: 'verification_incomplete',
    headline: 'Validation evidence is required before VALIDATION can pass',
    explanation:
      'Policy requires Discovery-derived verification commands to be active and executed. VALIDATION must not pass vacuously under this policy.',
  },
  {
    code: 'VALIDATION_EVIDENCE_UNVERIFIED',
    impact: 'verification_incomplete',
    headline: 'Validation evidence is unverified, so VALIDATION stays blocked',
    explanation:
      'Discovery is not trustworthy enough to confirm whether verification commands exist. VALIDATION is blocked fail-closed instead of asserting false certainty.',
  },
  {
    code: 'VALIDATION_EVIDENCE_STACK_NO_COMMANDS',
    impact: 'verification_incomplete',
    headline: 'A detected stack produced no verification commands, so VALIDATION stays blocked',
    explanation:
      'Discovery found a technology stack but derived no verification commands from it. A stack with zero active checks is treated as a mis-detection hazard, not a verified no-commands property.',
  },

  // ─── ProofGraph evidence approval gates (#695) ────────────────────────────
  {
    code: 'PROOFGRAPH_CERTIFICATE_INVALID',
    impact: 'verification_incomplete',
    headline: 'Evidence approval is blocked by a missing or stale plan certificate',
    explanation:
      'The plan approval certificate is missing, stale, or does not bind the current plan version.',
  },
  {
    code: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
    impact: 'verification_incomplete',
    headline: 'Evidence approval is blocked because critical claims have no proof evaluation',
    explanation:
      'Certificate-authorized critical plan claims have no persisted ProofGraph evaluation. Evidence approval cannot proceed on un-evaluated claims.',
  },
  {
    code: 'PROOFGRAPH_RISK_ASSESSMENT_STALE',
    impact: 'verification_incomplete',
    headline: 'Evidence approval is blocked by a stale implementation risk assessment',
    explanation:
      'The implementation risk assessment is missing, stale, or predates trigger classification. Record a fresh assessment before approving.',
  },
  {
    code: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
    impact: 'verification_incomplete',
    headline: 'Evidence approval requires a critical, certificate-authorized fact claim',
    explanation:
      'The declared risk triggers require at least one critical, certificate-authorized fact claim to be recorded and proven before approval.',
  },
  {
    code: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
    impact: 'verification_incomplete',
    headline: 'Evidence approval is blocked because critical fact claims are not proven',
    explanation:
      'One or more critical, certificate-authorized fact claims are not yet PROVEN in the persisted ProofGraph.',
  },

  // ─── Subject stability ────────────────────────────────────────────────────
  {
    code: 'VALIDATION_SUBJECT_CHANGED',
    impact: 'verification_incomplete',
    headline: 'The validation subject changed while checks were running',
    explanation:
      'The plan or implementation under validation changed during the check run, so the results cannot be bound to a stable subject digest. Re-run the check against the current subject.',
  },
  {
    code: 'VERIFICATION_SUBJECT_CHANGED',
    impact: 'verification_incomplete',
    headline: 'The execution subject changed during verification',
    explanation:
      'The execution subject changed during the verification phase, so evidence cannot be bound to a stable subject. Re-capture discovery and re-execute verification.',
  },

  // ─── Review identity and scope ────────────────────────────────────────────
  {
    code: 'FOUR_EYES_ACTOR_MATCH',
    impact: 'review_required',
    headline: 'Four-eyes review required: a different reviewer must approve',
    explanation:
      'The session initiator cannot approve their own work. A different person with reviewer permissions must provide the review decision.',
  },
  {
    code: 'REVIEW_SUBJECT_SCOPE_UNAVAILABLE',
    impact: 'review_required',
    headline: 'The review scope is not verifiable for this obligation',
    explanation:
      'The review obligation has no frozen reviewed-file scope, so scope verification is unavailable. Re-run the review to create an obligation with a verifiable frozen scope.',
  },

  // ─── Discovery health and drift (#412) ────────────────────────────────────
  {
    code: 'DISCOVERY_DRIFT_BLOCKED',
    impact: 'workflow_blocked',
    headline: 'Discovery drift blocks mutating tools',
    explanation:
      'The discovery surface drifted from the persisted binding and the onDrift policy blocks mutating tools. Reconcile drift before continuing.',
  },
  {
    code: 'DISCOVERY_HEALTH_UNAVAILABLE',
    impact: 'workflow_blocked',
    headline: 'Discovery evidence is unavailable; mutating tools are blocked',
    explanation:
      'Policy requires healthy Discovery before mutating tools may run. Restore Discovery evidence and run hydration to re-establish health.',
  },
  {
    code: 'DISCOVERY_HEALTH_DEGRADED',
    impact: 'workflow_blocked',
    headline: 'Discovery is degraded; mutating tools are blocked',
    explanation:
      'Discovery is available but degraded, and the onDegraded policy blocks mutating tools. Resolve the degraded collectors and re-run hydration.',
  },
];

const REASON_COPY_INDEX: ReadonlyMap<string, MigratedReasonCopy> = new Map(
  REASON_COPY.map((entry) => [entry.code, entry] as const),
);

/** Whether the code has been migrated onto the Human Projection. */
export function isMigratedReasonCode(code: string): boolean {
  return REASON_COPY_INDEX.has(code);
}

/** Look up the canonical human copy for a migrated code, if any. */
export function lookupReasonCopy(code: string): MigratedReasonCopy | undefined {
  return REASON_COPY_INDEX.get(code);
}
