/**
 * @module integration/tools/architecture-shared
 * @description Shared architecture tool types and cross-mode helpers.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolContext } from './helpers.js';
import {
  type MutableSession,
  formatBlocked,
  appendNextAction,
  writeStateWithArtifacts,
} from './helpers.js';

import type { SessionState } from '../../state/schema.js';
import { evaluate } from '../../machine/evaluate.js';

import { executeArchitecture } from '../../rails/architecture.js';

import type { AutoAdvanceResult } from '../../rails/types.js';
import { autoAdvance } from '../../rails/types.js';

import type { LoopVerdict, RevisionDelta, ReviewFindings } from '../../state/evidence.js';
import {
  ReviewFindings as ReviewFindingsSchema,
  validateAdrSections,
} from '../../state/evidence.js';

import {
  appendReviewObligation,
  consumeReviewObligation,
  createReviewObligation,
  ensureReviewAssurance,
  findAcceptedInvocationForFindings,
  findLatestObligation,
  findLatestUnconsumedObligation,
  reviewObligationResponseFields,
} from '../review/assurance.js';

import { requireReviewFindings, resolveHostTaskEffectiveFindings } from './review-validation.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../review/orchestration-mode.js';
import { buildPendingReviewInstruction } from '../review/pending-instruction.js';

import {
  PHASE_LABELS,
  buildArchitectureReviewCard,
  buildProductNextAction,
} from '../../presentation/index.js';
import { materializeReviewCardArtifact } from '../../adapters/workspace/index.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';

// ─── Shared Types ─────────────────────────────────────────────────────────

export type ArchitectureArgs = {
  title?: string;
  adrText?: string;
  reviewVerdict?: LoopVerdict;
  reviewFindings?: ReviewFindings;
  reviewerUnavailable?: boolean;
};

export type ArchitectureSession = MutableSession;

// ─── Shared Helpers ────────────────────────────────────────────────────────

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export function validateInitialSubmissionGate(
  args: ArchitectureArgs,
  state: SessionState,
  isInitialSubmission: boolean,
): string | null {
  const hasTitle = hasText(args.title);
  const hasAdrText = hasText(args.adrText);

  if (hasTitle && hasText(args.reviewVerdict)) {
    return formatBlocked('ADR_SUBMISSION_MIXED_INPUTS');
  }

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
  });
  return { next: instruction.next, reviewInvocation: instruction.reviewInvocation };
}
