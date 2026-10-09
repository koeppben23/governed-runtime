/**
 * @module integration/tools/architecture/architecture-shared
 * @description Shared architecture tool types and cross-mode helpers.
 *
 * @version v1
 */

import { formatBlocked } from '../../blocked-result.js';
import { validateAdrSections } from '../../../state/evidence.js';
import {
  ArchitectureClaimDeclarationInput,
  normalizeArchitectureClaims,
} from '../../../state/proofgraph-approval.js';
import { IntegrationInvariantError } from '../../errors.js';

import type { MutableSession } from '../helpers.js';
import type { SessionState } from '../../../state/schema.js';
import type { LoopVerdict } from '../../../state/evidence.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import type { ReviewDispatchAuthority } from '../../review/dispatch/dispatch-authority.js';
import { classifyToolCallMode } from '../review-validation-mode.js';
import {
  resolveRuntimeReviewPlatform,
  resolveReviewOrchestrationMode,
} from '../../review/dispatch/orchestration-mode.js';
import { buildChildSessionReviewInstruction } from '../../review/dispatch/child-session-instruction.js';

// ─── Shared Types ─────────────────────────────────────────────────────────

export type ArchitectureArgs = {
  title?: string;
  adrText?: string;
  claims?: ArchitectureClaimDeclarationInput[];
  reviewVerdict?: LoopVerdict;
  reviewerUnavailable?: boolean;
  /** Explicit typed transport-recovery intent for the pending ADR review. */
  reviewRecovery?: 'retry_transport';
  targetPaths?: string[];
};

export type ArchitectureSession = MutableSession;

// ─── Shared Helpers ────────────────────────────────────────────────────────

export function hasText(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

export type ArchitectureClaimsParseResult =
  | { readonly kind: 'ok'; readonly claims: ArchitectureClaimDeclarationInput[] | undefined }
  | { readonly kind: 'blocked'; readonly message: string };

/**
 * Validate architecture claim declarations at the tool boundary.
 *
 * The host may deliver raw model args that never passed the declared Zod
 * schema (defaults/strictness are not applied on every host path), so the
 * normalizer must only ever see schema-valid claims. Invalid input fails
 * closed with a typed blocked result instead of a raw spread TypeError.
 */
export function parseArchitectureClaimsInput(
  claims: readonly unknown[] | undefined,
): ArchitectureClaimsParseResult {
  if (claims === undefined) return { kind: 'ok', claims: undefined };
  if (!Array.isArray(claims)) {
    return {
      kind: 'blocked',
      message: formatBlocked('ARCHITECTURE_CLAIM_INVALID', {
        index: '1',
        field: 'claims',
        detail: 'claims must be an array of architecture claim declarations',
      }),
    };
  }
  const parsed: ArchitectureClaimDeclarationInput[] = [];
  for (const [index, claim] of claims.entries()) {
    const result = ArchitectureClaimDeclarationInput.safeParse(claim);
    if (!result.success) {
      const issue = result.error.issues[0];
      return {
        kind: 'blocked',
        message: formatBlocked('ARCHITECTURE_CLAIM_INVALID', {
          index: String(index + 1),
          field: issue?.path.join('.') || 'claim',
          detail: issue?.message ?? 'invalid claim declaration',
        }),
      };
    }
    parsed.push(result.data);
  }
  return { kind: 'ok', claims: parsed };
}

/** Argument-shape validation only — never gates on obligation lifecycle state. */
export function validateArchitectureCallShape(args: ArchitectureArgs): string | null {
  const hasTitle = hasText(args.title);

  // title + verdict keeps its distinct code (submission metadata with a verdict).
  if (hasTitle && hasText(args.reviewVerdict)) {
    return formatBlocked('ADR_SUBMISSION_MIXED_INPUTS');
  }

  // Canonical argument-shape validation (closes the historical architecture gaps:
  // adrText+verdict=accept, reviewerUnavailable+submission).
  // `text` is the heavy ADR payload (adrText); title is handled above.
  const mode = classifyToolCallMode('architecture', {
    text: args.adrText,
    reviewVerdict: args.reviewVerdict,
    reviewerUnavailable: args.reviewerUnavailable,
    reviewRecovery: args.reviewRecovery,
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
  authority: ReviewDispatchAuthority;
  iteration: number;
  planVersion: number;
  subjectLabel: string;
  /** State whose declarations/graph the reviewer prompt must reflect (#762). */
  state: SessionState;
}) {
  const platform = resolveRuntimeReviewPlatform();
  const mode = resolveReviewOrchestrationMode({
    platform,
    nativeReviewerAvailable: platform === 'unknown' ? false : true,
  });
  return buildChildSessionReviewInstruction({
    mode,
    platform,
    authority: input.authority,
    iteration: input.iteration,
    planVersion: input.planVersion,
    ...(input.authority.attempt.observationCapability !== undefined
      ? { observationCapability: input.authority.attempt.observationCapability }
      : {}),
  });
}

export function buildRestartedState(
  state: SessionState,
  input: {
    nextAdr: NonNullable<SessionState['architecture']>;
    sameRevision: boolean;
    revisionDelta: 'none' | 'minor';
    assurance: SessionState['reviewAssurance'];
  },
): SessionState {
  const selfReview = state.selfReview;
  const architecture = state.architecture;
  if (!selfReview || !architecture) {
    throw new IntegrationInvariantError(
      'ARCHITECTURE_RESTART_STATE_REQUIRED',
      'an architecture review restart requires architecture and self-review state',
    );
  }
  // ADR identity, createdAt, and nextAdrNumber are NEVER mutated here:
  // a blocked review obligation is a new review generation, not a new ADR.
  return {
    ...state,
    architecture: input.nextAdr,
    selfReview: {
      ...selfReview,
      prevDigest: input.sameRevision ? selfReview.prevDigest : architecture.digest,
      currDigest: input.nextAdr.digest,
      revisionDelta: input.sameRevision ? selfReview.revisionDelta : input.revisionDelta,
      verdict: 'changes_requested',
    },
    reviewAssurance: input.assurance,
  };
}

export function resolveRestartRevision(
  args: ArchitectureArgs,
  state: SessionState,
  submittedDigest: string,
  sameRevision: boolean,
):
  | { readonly kind: 'blocked'; readonly blocked: string }
  | {
      readonly kind: 'ok';
      readonly nextAdr: NonNullable<SessionState['architecture']>;
      readonly revisionDelta: 'none' | 'minor';
    } {
  const architecture = state.architecture;
  if (!architecture) {
    throw new IntegrationInvariantError(
      'NO_ARCHITECTURE',
      'an architecture review restart resolution requires ADR state',
    );
  }
  if (sameRevision) {
    return { kind: 'ok', nextAdr: architecture, revisionDelta: 'none' };
  }
  const adrText = args.adrText;
  if (adrText === undefined) {
    throw new IntegrationInvariantError(
      'EMPTY_ADR_TEXT',
      'an architecture revision requires ADR text to validate',
    );
  }
  const missingSections = validateAdrSections(adrText);
  if (missingSections.length > 0) {
    return {
      kind: 'blocked',
      blocked: formatBlocked('MISSING_ADR_SECTIONS', {
        sections: missingSections.join(', '),
      }),
    };
  }
  let claimDeclarations:
    | {
        flow: 'architecture';
        claims: NonNullable<ReturnType<typeof normalizeArchitectureClaims>>;
      }
    | undefined;
  if (args.claims) {
    const normalizedClaims = normalizeArchitectureClaims(args.claims);
    if (normalizedClaims === undefined) {
      throw new IntegrationInvariantError(
        'PROOFGRAPH_CLAIM_NORMALIZATION_UNAVAILABLE',
        'normalizing submitted architecture claims produced no canonical declarations',
      );
    }
    claimDeclarations = { flow: 'architecture', claims: normalizedClaims };
  }
  return {
    kind: 'ok',
    nextAdr: {
      ...architecture,
      adrText,
      digest: submittedDigest,
      ...(claimDeclarations ? { claimDeclarations } : {}),
      // A revision invalidates any prior approval over the old digest.
      approvalCertificate: undefined,
    },
    revisionDelta: 'minor',
  };
}
