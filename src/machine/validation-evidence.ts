/**
 * @module machine/validation-evidence
 * @description Single canonical authority for policy-gated validation-evidence
 *              enforcement (#400).
 *
 * Problem: Under HIGH-RISK/regulated policy, VALIDATION could pass vacuously when
 * `activeChecks` is empty (no Discovery-derived verification commands). That silent
 * pass is an AUTO-ADVANCE hazard: PLAN_REVIEW APPROVE → VALIDATION → ALL_PASSED →
 * IMPLEMENTATION with no runtime verification evidence. This module decides, purely
 * from SessionState, whether progressing past VALIDATION without verification
 * evidence is admissible.
 *
 * Authority contract:
 * - This is the ONLY authority that decides validation-evidence admissibility.
 *   Guards, rails, and surfacing tools MUST consume `evaluateValidationEvidence`
 *   rather than re-deriving the rule. Do not create a second authority.
 * - Fail-closed: under `required`, an empty active-check list blocks unless an
 *   explicit policy exception (`allowNoCommands`) is set.
 * - Never fabricates evidence and never injects fallback commands;
 *   `verificationCandidates`/`activeChecks` remain the sole source of truth for
 *   what may be executed. This module only governs progression admissibility.
 * - Evidence honesty: when Discovery is not trustworthy, the runtime cannot prove
 *   that "no commands" is a true repo property, so it returns an explicit
 *   NOT_VERIFIED outcome instead of asserting a required-but-known block.
 */

import type { SessionState } from '../state/schema.js';

/** Reason codes surfaced by the validation-evidence authority (#400). */
export type ValidationEvidenceReasonCode =
  | 'VALIDATION_EVIDENCE_REQUIRED'
  | 'VALIDATION_EVIDENCE_UNVERIFIED';

/** Outcome of a validation-evidence evaluation. Pure value object. */
export interface ValidationEvidenceDecision {
  /**
   * When true, VALIDATION must NOT pass vacuously: the session has no active
   * verification checks and policy does not permit progression without evidence.
   */
  readonly blocked: boolean;
  /**
   * Effective enforcement after applying the explicit `allowNoCommands` exception.
   * True only when enforcement==='required' AND allowNoCommands===false.
   */
  readonly required: boolean;
  /** Reason code when blocked; null otherwise. */
  readonly code: ValidationEvidenceReasonCode | null;
}

/**
 * Whether Discovery is trustworthy enough to assert that the absence of
 * verification commands reflects a true repository property (rather than missing,
 * stale, drifted, or degraded Discovery).
 *
 * Trustworthy requires ALL of the following, fail-closed by default:
 * - persisted Discovery evidence is present (`discoverySummary` AND
 *   `discoveryDigest` are non-null);
 * - the frozen policy snapshot enforces Discovery health (`discoveryHealth`
 *   enforcement is 'required') — i.e. the session is operating under a posture
 *   where Discovery health is actually gated;
 * - the Discovery health gate is present and CLEAR (a missing gate is not
 *   trustworthy, a blocked gate is not trustworthy);
 * - the last cached drift assessment on the clear gate is 'clean' (any other
 *   value — drifted/unavailable/timeout/missing_discovery/not_checked — is not
 *   trustworthy).
 *
 * Reused exclusively by `evaluateValidationEvidence`. Exported for negative-path
 * test coverage of each trust edge.
 */
export function hasTrustworthyDiscoveryForVerification(state: SessionState): boolean {
  if (state.discoverySummary == null || state.discoveryDigest == null) {
    return false;
  }

  if (state.policySnapshot.discoveryHealth?.enforcement !== 'required') {
    return false;
  }

  const gate = state.discoveryHealthGate;
  if (gate == null || gate.status !== 'clear') {
    return false;
  }

  return gate.lastDriftAssessment === 'clean';
}

/**
 * Decide whether progressing past VALIDATION without verification evidence is
 * admissible, purely from SessionState.
 *
 * Decision table (only relevant when `activeChecks` is empty — a non-empty
 * active-check list is governed by the normal pass/fail check evaluation and is
 * never blocked here):
 *
 * - enforcement 'off' / 'advisory' : never blocks (legacy/observe-only). Preserves
 *   the historical vacuous-pass behavior for low-risk modes.
 * - enforcement 'required' + allowNoCommands===true : explicit, policy-backed
 *   exception. Never blocks. This is the ONLY sanctioned opt-out.
 * - enforcement 'required' + allowNoCommands===false (the fail-closed default for
 *   regulated/team-ci):
 *     - Discovery trustworthy   → VALIDATION_EVIDENCE_REQUIRED (the empty list is a
 *       verified repo property; policy forbids vacuous pass).
 *     - Discovery NOT trustworthy → VALIDATION_EVIDENCE_UNVERIFIED (cannot prove the
 *       empty list is real; refuse false certainty and block fail-closed).
 */
export function evaluateValidationEvidence(state: SessionState): ValidationEvidenceDecision {
  const policy = state.policySnapshot.validationEvidence;
  const required = policy.enforcement === 'required' && policy.allowNoCommands === false;

  // Non-empty active checks: ordinary check evaluation governs; not this authority.
  if (state.activeChecks.length > 0) {
    return { blocked: false, required, code: null };
  }

  if (!required) {
    return { blocked: false, required, code: null };
  }

  const code: ValidationEvidenceReasonCode = hasTrustworthyDiscoveryForVerification(state)
    ? 'VALIDATION_EVIDENCE_REQUIRED'
    : 'VALIDATION_EVIDENCE_UNVERIFIED';

  return { blocked: true, required, code };
}
