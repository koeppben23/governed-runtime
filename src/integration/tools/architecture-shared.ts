/**
 * @module integration/tools/architecture-shared
 * @description Shared architecture tool types and cross-mode helpers.
 *
 * @version v1
 */

import { formatBlocked } from './helpers.js';
import type { MutableSession } from './helpers.js';
import type { SessionState } from '../../state/schema.js';
import type { LoopVerdict, ReviewFindings } from '../../state/evidence.js';
import type { ArchitectureClaimDeclarationInput } from '../../state/proofgraph-approval.js';
import { ensureReviewAssurance, createReviewObligation } from '../review/assurance.js';
import { classifyToolCallMode } from './review-validation-mode.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';
import { resolveAttemptObservationCapability } from '../review/assurance.js';
import { buildReviewerProofContext } from '../review/proof-context.js';

// ─── Shared Types ─────────────────────────────────────────────────────────

export type ArchitectureArgs = {
  title?: string;
  adrText?: string;
  claims?: ArchitectureClaimDeclarationInput[];
  reviewVerdict?: LoopVerdict;
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
  targetPaths?: string[];
};

export type ArchitectureSession = MutableSession;

// ─── Shared Helpers ────────────────────────────────────────────────────────

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Argument-shape validation only — never gates on obligation lifecycle state. */
export function validateArchitectureCallShape(args: ArchitectureArgs): string | null {
  const hasTitle = hasText(args.title);

  // title + verdict keeps its distinct code (submission metadata with a verdict).
  if (hasTitle && hasText(args.reviewVerdict)) {
    return formatBlocked('ADR_SUBMISSION_MIXED_INPUTS');
  }

  // Canonical argument-shape validation (closes the historical architecture gaps:
  // adrText+verdict=accept, findings-without-verdict, reviewerUnavailable+submission).
  // `text` is the heavy ADR payload (adrText); title is handled above.
  const mode = classifyToolCallMode('architecture', {
    text: args.adrText,
    reviewVerdict: args.reviewVerdict,
    reviewFindings: args.reviewFindings,
    reviewerUnavailable: args.reviewerUnavailable,
  });
  if (mode.kind === 'invalid') return formatBlocked(mode.code, mode.params);
  return null;
}

export function validateInitialSubmissionGate(
  args: ArchitectureArgs,
  state: SessionState,
  isInitialSubmission: boolean,
): string | null {
  const shapeBlocked = validateArchitectureCallShape(args);
  if (shapeBlocked) return shapeBlocked;
  const hasTitle = hasText(args.title);
  const hasAdrText = hasText(args.adrText);

  if (!isInitialSubmission || (!hasTitle && !hasAdrText) || state.phase !== 'ARCHITECTURE') {
    return null;
  }
  if (!state.selfReview) return null;

  const assurance = ensureReviewAssurance(state.reviewAssurance);
  const blockedArchObligations = assurance.obligations.filter(
    (o) => o.obligationType === 'architecture' && o.status === 'blocked',
  );
  const lastArchObligation = [...assurance.obligations]
    .reverse()
    .find((o) => o.obligationType === 'architecture');

  if (lastArchObligation?.status !== 'blocked') {
    return formatBlocked('ADR_REVIEW_IN_PROGRESS');
  }
  if (blockedArchObligations.length >= 3) {
    return formatBlocked('ORCHESTRATION_PERMANENTLY_FAILED', {
      attempts: String(blockedArchObligations.length),
    });
  }
  return null;
}

export function buildArchitectureReviewInstruction(input: {
  policy: ArchitectureSession['policy'];
  subagentEnabled: boolean;
  obligation: ReturnType<typeof createReviewObligation> | null;
  iteration: number;
  planVersion: number;
  subjectLabel: string;
  /** State whose declarations/graph the reviewer prompt must reflect (#762). */
  state: SessionState;
}): {
  next: string;
  reviewInvocation?: ReturnType<typeof buildPendingReviewInstruction>['reviewInvocation'];
} {
  const { subagentEnabled } = input;
  if (!subagentEnabled) {
    return {
      next:
        'Self-review needed. Review the ADR critically against MADR standards. ' +
        'Check for completeness, clarity, and consequences coverage. ' +
        'Then call flowguard_architecture with reviewVerdict.',
    };
  }
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    reviewInvocationPolicy: input.policy.reviewInvocationPolicy,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
    manualAttestedAllowed: input.policy.reviewInvocationPolicy !== 'host_task_required',
  });
  const instruction = buildPendingReviewInstruction({
    mode,
    platform,
    reviewKind: 'architecture',
    obligation: input.obligation,
    iteration: input.iteration,
    planVersion: input.planVersion,
    subjectLabel: input.subjectLabel,
    proofContext: buildReviewerProofContext(input.state),
    observationCapability: input.obligation
      ? (resolveAttemptObservationCapability(
          input.state.reviewAssurance,
          input.obligation.obligationId,
        ) ?? undefined)
      : undefined,
  });
  return { next: instruction.next, reviewInvocation: instruction.reviewInvocation };
}
