/**
 * @module integration/review/shared-helpers
 * @description Shared pure functions and constants for review evidence handling.
 *
 * Extracted from plugin-orchestrator.ts and plugin-workspace.ts so review/ modules
 * do not depend on plugin-* files (FG-QUAL-002).
 *
 * @version v2
 */

import type { SessionState } from '../../state/schema.js';
import type { SemanticAuditIntent } from '../audit-outbox.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import type { ReviewVerificationEvidenceItem } from './types.js';
import type { AttestationResult } from './pipeline-types.js';

// ─── Reason Constants ────────────────────────────────────────────────────────

export const REASON_MANDATE_MISSING = 'SUBAGENT_MANDATE_MISSING';
export const REASON_MANDATE_MISMATCH = 'SUBAGENT_MANDATE_MISMATCH';
export const REASON_UNABLE_TO_REVIEW = 'SUBAGENT_UNABLE_TO_REVIEW';

// ─── Strict Attestation Validation ───────────────────────────────────────────

/**
 * Validate strict attestation fields against expected review context values.
 *
 * Content pipeline uses values from reviewCtx; standard pipeline uses
 * module-level constants. Both paths share the same structural check.
 */
export function validatePipelineAttestation(
  findings: {
    reviewMode?: string;
    attestation?: Record<string, unknown> | null;
    overallVerdict?: string;
  },
  expected: {
    obligationId: string;
    criteriaVersion: string;
    mandateDigest: string;
    iteration: number;
    planVersion: number;
    checkReviewedBy: boolean;
    checkUnableToReview: boolean;
  },
): AttestationResult {
  const att = findings.attestation;
  if (!att) {
    return {
      valid: false,
      code: REASON_MANDATE_MISSING,
      detail: { obligationId: expected.obligationId },
    };
  }

  const fieldMismatch =
    findings.reviewMode !== 'subagent' ||
    att.toolObligationId !== expected.obligationId ||
    att.iteration !== expected.iteration ||
    att.planVersion !== expected.planVersion ||
    att.criteriaVersion !== expected.criteriaVersion ||
    att.mandateDigest !== expected.mandateDigest ||
    (expected.checkReviewedBy && att.reviewedBy !== REVIEWER_SUBAGENT_TYPE);

  if (fieldMismatch) {
    return {
      valid: false,
      code: REASON_MANDATE_MISMATCH,
      detail: { obligationId: expected.obligationId },
    };
  }

  if (expected.checkUnableToReview && findings.overallVerdict === 'unable_to_review') {
    return {
      valid: false,
      code: REASON_UNABLE_TO_REVIEW,
      detail: { obligationId: expected.obligationId },
    };
  }

  return { valid: true };
}

function assertionRequirementKey(checkId: string, providerId: string, localId: string): string {
  return `${checkId}\u0000${providerId}\u0000${localId}`;
}

function declaredAssertionRequirementKeys(state: SessionState): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const claim of state.plan?.claimDeclarations?.claims ?? []) {
    const requirement = claim.counterexampleRequirement;
    if (requirement?.kind !== 'assertion') continue;
    keys.add(
      assertionRequirementKey(
        requirement.checkId,
        requirement.assertion.providerId,
        requirement.assertion.localId,
      ),
    );
  }
  return keys;
}

function projectClaimAssertionEvidence(
  attempt: Extract<SessionState['validationAttempts'][number], { scope: 'implementation' }>,
  requirementKeys: ReadonlySet<string>,
): ReviewVerificationEvidenceItem['claimAssertionEvidence'] {
  const extraction = attempt.result.assertionExtraction;
  if (extraction?.status !== 'extracted' || requirementKeys.size === 0) return undefined;
  const assertions = extraction.assertions
    .filter((assertion) =>
      requirementKeys.has(
        assertionRequirementKey(
          attempt.result.checkId,
          assertion.providerId,
          assertion.assertion.localId,
        ),
      ),
    )
    .map((assertion) => ({
      checkId: attempt.result.checkId,
      providerId: assertion.providerId,
      localId: assertion.assertion.localId,
      status: assertion.status,
      ...(assertion.suiteName ? { suiteName: assertion.suiteName } : {}),
      testName: assertion.testName,
      ...(assertion.sourceFile ? { sourceFile: assertion.sourceFile } : {}),
      ...(assertion.durationMs !== undefined ? { durationMs: assertion.durationMs } : {}),
    }));
  return assertions.length === 0
    ? undefined
    : { reportDigests: [...extraction.reportDigests], assertions };
}

export function stateVerificationEvidence(
  state: SessionState,
): readonly ReviewVerificationEvidenceItem[] {
  const currentDigest = state.implementation?.digest;
  if (!currentDigest) return [];
  const requirementKeys = declaredAssertionRequirementKeys(state);
  return state.validationAttempts
    .filter(
      (
        attempt,
      ): attempt is Extract<
        SessionState['validationAttempts'][number],
        { scope: 'implementation' }
      > => attempt.scope === 'implementation' && attempt.implementationDigest === currentDigest,
    )
    .map((attempt) => {
      const claimAssertionEvidence = projectClaimAssertionEvidence(attempt, requirementKeys);
      return {
        attemptId: attempt.attemptId,
        kind: attempt.result.kind,
        command: attempt.result.command,
        passed: attempt.result.passed,
        exitCode: attempt.result.exitCode,
        timedOut: attempt.result.timedOut,
        executionMs: attempt.result.executionMs,
        outputDigest: attempt.result.outputDigest,
        detail: attempt.result.detail,
        executedAt: attempt.result.executedAt,
        executionObservedStateDigest: attempt.executionObservation.executionObservedStateDigest,
        preCommitStateDigest: attempt.executionObservation.preCommitStateDigest,
        stateChangedDuringExecution:
          attempt.executionObservation.executionObservedStateDigest !==
          attempt.executionObservation.preCommitStateDigest,
        ...(claimAssertionEvidence ? { claimAssertionEvidence } : {}),
      };
    });
}

// ─── State + Audit Persistence Helper ────────────────────────────────────────

/**
 * Dependencies needed by {@link recordAssuranceWithAudit}.
 *
 * Uses {@link SessionState} for state mutation typing.
 */
export interface AssuranceAuditDeps {
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
    semanticIntents?: (state: SessionState, now: string) => readonly SemanticAuditIntent[],
  ): Promise<void>;
}

/**
 * Record a review assurance state mutation together with its audit event.
 *
 * The semantic event intent is committed in the same state transaction as the
 * mutation. The durable audit reconciler appends it idempotently after a crash;
 * callers never perform a second post-state audit write.
 */
export async function recordAssuranceWithAudit(
  deps: AssuranceAuditDeps,
  opts: {
    sessDir: string;
    stateMutation: (state: SessionState, now: string) => SessionState;
    auditEventName: string;
    auditDetail: Record<string, unknown>;
  },
): Promise<{ auditOk: boolean; block?: boolean; code?: string; reason?: string }> {
  const { sessDir, stateMutation, auditEventName, auditDetail } = opts;
  await deps.updateReviewAssurance(sessDir, stateMutation, (state, now) => [
    {
      phase: state.phase,
      event: auditEventName,
      occurredAt: now,
      detail: auditDetail,
    },
  ]);
  return { auditOk: true };
}
