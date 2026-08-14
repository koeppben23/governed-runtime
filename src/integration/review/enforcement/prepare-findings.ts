/**
 * @module integration/review/enforcement/prepare-findings
 * @description The single authority that turns raw reviewer output into a
 *              host-normalized canonical ReviewFindings candidate.
 *
 * Boundary contract (two semantic stages):
 *
 *   raw reviewer output
 *   → prepareReviewerFindingsForValidation()
 *       - host provenance stamping (F8: reviewedBy/reviewedAt)
 *       - attestation host-constant stamping (mandateDigest/criteriaVersion/
 *         reviewedBy literal)
 *       - challenge identity minting (challengeId) and obligation binding
 *       - strict canonical ReviewFindings parse
 *   → canonical candidate | schema_invalid | client_reference_invalid
 *
 *   → bind-time authorization (NOT in this module)
 *       - canonical evidence-ref binding (challenge_evidence_unknown)
 *       - challenge contract, scope, consistency, duplicate rules
 *
 * This module repairs NOTHING that is reviewer-owned: unknown keys, wrong
 * revisions, invalid outcomes, and malformed subject anchors remain strict
 * schema errors. Only host-owned fields are stamped or overwritten.
 *
 * Both the evidence-binding path (evidence-binding.ts) and the transient
 * enforcement path (enforcement.ts / prompt-integrity.ts) consume this
 * authority, so schema errors shown to the reviewer are structurally the same
 * errors that prevented binding.
 *
 * @version v1
 */

import { ReviewActorInfo, ReviewFindings } from '../../../state/evidence-review.js';
import { ReviewerFindingsInput } from '../../../state/evidence-review-input.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../tool-names.js';
import { normalizeChallenges } from './normalize.js';
import type { PendingReview } from './types.js';
import { validateReviewFindingsConsistency } from './findings-consistency.js';

// ─── Attestation Resolution ───────────────────────────────────────────────────

/**
 * Reviewer-supplied attestation, reduced to what validation depends on.
 *
 * `toolObligationId` is the only field that makes an attestation valid for
 * host stamping: host-owned constants are authoritative regardless of what the
 * reviewer echoed, but they are only stamped onto an attestation the reviewer
 * actually bound to an obligation.
 */
export function resolveAttestationInfo(attestation: Record<string, unknown> | undefined): {
  attestedObligationId: string | null;
  hasValidAttestation: boolean;
} {
  const attestedObligationId =
    typeof attestation?.toolObligationId === 'string' ? attestation.toolObligationId : null;
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return {
    attestedObligationId,
    hasValidAttestation: !!attestedObligationId && uuidRe.test(attestedObligationId),
  };
}

// ─── Host Provenance (F8) ─────────────────────────────────────────────────────

/**
 * Replace model-authored `reviewedAt` / `reviewedBy` with host-authoritative
 * values, retaining the model's originals as untrusted `reviewerClaimedAt` /
 * `reviewerClaimedBy` diagnostics (F8).
 *
 * The ENTIRE reviewedBy block is host-constructed — not just sessionId. A model
 * that echoes the real child session id could otherwise still fabricate actorId,
 * actorSource, or actorAssurance (e.g. actorSource="verified_identity",
 * actorAssurance="cryptographic") and have them persisted as canonical
 * provenance. reviewerClaimedBy always preserves the complete original model
 * block whenever the model supplied one, independent of any field comparison.
 */
function applyHostProvenance(
  rawFindings: Record<string, unknown>,
  childSessionId: string,
  now: string,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...rawFindings };

  const claimedAt = rawFindings.reviewedAt;
  if (typeof claimedAt === 'string' && claimedAt && claimedAt !== now) {
    result.reviewerClaimedAt = claimedAt;
  }
  result.reviewedAt = now;

  const claimedBy = rawFindings.reviewedBy;
  // Preserve the complete original model block whenever one was supplied — not
  // only when the claimed sessionId diverges. actorId/actorSource/actorAssurance
  // can be confabulated even when the sessionId happens to match.
  //
  // `reviewerClaimedBy` is diagnostics-only and never audit authority, so it must
  // never be able to fail the bind: a reviewer that emits a malformed block (for
  // example `reviewedBy: {}`) would otherwise make the whole invocation
  // schema_invalid even though the host-authoritative `reviewedBy` below is
  // correct. Retain it only when it actually satisfies the actor shape.
  if (claimedBy && typeof claimedBy === 'object' && !Array.isArray(claimedBy)) {
    if (ReviewActorInfo.safeParse(claimedBy).success) {
      result.reviewerClaimedBy = claimedBy;
    } else {
      delete result.reviewerClaimedBy;
    }
  }
  result.reviewedBy = buildHostReviewedBy(childSessionId);

  return result;
}

/**
 * Build the fully host-authoritative `reviewedBy` block. Every field is a
 * host-known value; NOTHING is carried over from the model payload. When the
 * host has no independently-resolved reviewer identity, neutral truthful values
 * are used that describe exactly what the host knows: the reviewer is the
 * flowguard-reviewer subagent bound to the resolved child session, with an
 * unverified (best-effort) identity assurance.
 */
function buildHostReviewedBy(childSessionId: string): Record<string, unknown> {
  return {
    sessionId: childSessionId,
    actorId: REVIEWER_SUBAGENT_TYPE,
    actorSource: 'unknown',
    actorAssurance: 'best_effort',
  };
}

// ─── The Single Authority ─────────────────────────────────────────────────────

export interface PrepareFindingsHostConstants {
  readonly mandateDigest: string;
  readonly criteriaVersion: string;
}

export interface PrepareFindingsHostProvenance {
  readonly childSessionId: string;
  readonly reviewedAt: string;
}

export type PrepareReviewerFindingsResult =
  | { readonly ok: true; readonly findings: Record<string, unknown> }
  | {
      readonly ok: false;
      readonly code: 'schema_invalid';
      readonly issues: readonly string[];
      /**
       * Machine-readable issue keys (path, code, message) for the canonical
       * repair fingerprint. Display text stays in `issues`.
       */
      readonly issueKeys: readonly {
        readonly path: string;
        readonly code: string;
        readonly message: string;
      }[];
    }
  | {
      readonly ok: false;
      readonly code: 'client_reference_invalid';
      readonly issues: readonly string[];
      readonly details: { readonly clientReference: string; readonly index: number };
    };

function schemaIssuePath(issue: {
  path: readonly PropertyKey[];
  keys?: readonly PropertyKey[];
}): string {
  const path = issue.path.length > 0 ? issue.path : (issue.keys ?? []);
  return path.map(String).join('.');
}

/**
 * Host-owned mechanical normalization followed by the canonical schema gate.
 *
 * Ordering is a correctness contract, not a preference:
 *  1. The untrusted reviewer-owned input clears its strict DTO boundary.
 *  2. Host provenance and attestation constants are stamped only after that.
 *  3. Challenge identity is minted host-side. The canonical prompt asks for a
 *     `clientReference` slug and never for a `challengeId`, so skipping this
 *     makes EVERY prompt-compliant reviewer output `schema_invalid`.
 *  4. The canonical schema gate runs — the single authority on payload validity.
 *
 * No reviewer-owned semantics are repaired anywhere in this function.
 */
export function prepareReviewerFindingsForValidation(input: {
  rawFindings: Record<string, unknown>;
  obligationId: string;
  hostConstants: PrepareFindingsHostConstants;
  hostProvenance: PrepareFindingsHostProvenance;
}): PrepareReviewerFindingsResult {
  const { rawFindings, obligationId, hostConstants, hostProvenance } = input;

  const reviewerInput = ReviewerFindingsInput.safeParse(rawFindings);
  if (!reviewerInput.success) {
    return {
      ok: false,
      code: 'schema_invalid',
      issues: reviewerInput.error.issues.map(
        (issue) => `${schemaIssuePath(issue)}: ${issue.message}`,
      ),
      issueKeys: reviewerInput.error.issues.map((issue) => ({
        path: schemaIssuePath(issue),
        code: issue.code,
        message: issue.message,
      })),
    };
  }

  const provenanceFindings = applyHostProvenance(
    reviewerInput.data,
    hostProvenance.childSessionId,
    hostProvenance.reviewedAt,
  );

  const attestation = provenanceFindings.attestation as { toolObligationId: string };
  let hostAttestationFindings: Record<string, unknown> = {
    ...provenanceFindings,
    attestation: {
      toolObligationId: attestation.toolObligationId,
      iteration: reviewerInput.data.iteration,
      planVersion: reviewerInput.data.planVersion,
      mandateDigest: hostConstants.mandateDigest,
      criteriaVersion: hostConstants.criteriaVersion,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
  };

  const rawChallenges = hostAttestationFindings.challenges;
  if (Array.isArray(rawChallenges)) {
    const normalized = normalizeChallenges(rawChallenges, obligationId);
    if (!normalized.ok) {
      return {
        ok: false,
        code: 'client_reference_invalid',
        issues: [
          `challenges.${normalized.index}.clientReference: Duplicate clientReference "${normalized.clientReference}" in reviewer challenges. Each challenge needs a unique reference.`,
        ],
        details: {
          clientReference: normalized.clientReference,
          index: normalized.index,
        },
      };
    }
    hostAttestationFindings = { ...hostAttestationFindings, challenges: normalized.challenges };
  }

  const parsed = ReviewFindings.safeParse(hostAttestationFindings);
  if (!parsed.success) {
    return {
      ok: false,
      code: 'schema_invalid',
      issues: parsed.error.issues.map((issue) => `${schemaIssuePath(issue)}: ${issue.message}`),
      // Machine-readable issue keys for the canonical repair fingerprint.
      // The human-readable `issues` above remain the display form; these keys
      // are sorted and hashed into ReviewAttempt.schemaErrorFingerprint so the
      // output-repair gate can detect a repair that reproduced the identical
      // error set.
      issueKeys: parsed.error.issues.map((issue) => ({
        path: schemaIssuePath(issue),
        code: issue.code,
        message: issue.message,
      })),
    };
  }
  return { ok: true, findings: hostAttestationFindings };
}

// ─── Transient Capture Usability ──────────────────────────────────────────────

interface CaptureValidationContext {
  readonly raw: Record<string, unknown>;
  readonly obligationId: string;
  readonly hostConstants: PrepareFindingsHostConstants;
  readonly childSessionId: string;
  readonly reviewedAt: string;
}

/**
 * The shared precondition guard for the transient capture queries. Returns the
 * validation inputs when a capture exists AND the pending review carries the
 * structural host context (obligation identity + host attestation constants),
 * and null otherwise — structural defects are handled as an explicit
 * non-repairable blocker (enforcementFailure), never as a reviewer retry.
 */
function captureValidationContext(pending: PendingReview): CaptureValidationContext | null {
  if (pendingIsStructurallyFailed(pending)) return null;
  if (pending.subagentRecord?.terminationReason === 'step_exhausted') return null;
  const raw = pending.capturedFindings?.rawFindings;
  if (!raw) return null;
  const obligationId = pending.obligationId;
  const hostConstants = pending.hostAttestationConstants ?? null;
  if (obligationId == null || hostConstants == null) return null;
  const subagentRecord = pending.subagentRecord;
  const childSessionId = subagentRecord?.sessionId;
  if (!subagentRecord || !childSessionId) return null;
  return {
    raw,
    obligationId,
    hostConstants,
    childSessionId,
    reviewedAt: subagentRecord.completedAt,
  };
}

function pendingIsStructurallyFailed(pending: PendingReview): boolean {
  return (pending.enforcementFailure ?? null) !== null;
}

/**
 * Reviewer-actionable schema issues of the current capture, computed through
 * the same host-normalization authority the bind gate uses. Returns null when
 * the capture is absent, structurally unassessable, or valid.
 */
export function extractCaptureSchemaErrors(pending: PendingReview): readonly string[] | null {
  const context = captureValidationContext(pending);
  if (!context) return null;
  const result = prepareReviewerFindingsForValidation({
    rawFindings: context.raw,
    obligationId: context.obligationId,
    hostConstants: context.hostConstants,
    hostProvenance: {
      childSessionId: context.childSessionId,
      reviewedAt: context.reviewedAt,
    },
  });
  if (result.ok) return null;
  return result.issues;
}

/**
 * Pure query: whether a pending review's capture could bind at all.
 *
 * Returns false for:
 * - a structural host-context defect (enforcementFailure) — never repairable
 *   by a reviewer, see enforcement.ts;
 * - a terminated subagent (step_exhausted);
 * - an absent capture;
 * - a capture that fails host normalization + the canonical schema gate;
 * - an internally incoherent capture (accept with blocking issues).
 *
 * This function NEVER mutates the pending review.
 */
export function isPendingCaptureUsable(pending: PendingReview): boolean {
  const context = captureValidationContext(pending);
  if (!context) return false;
  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: context.raw,
    obligationId: context.obligationId,
    hostConstants: context.hostConstants,
    hostProvenance: {
      childSessionId: context.childSessionId,
      reviewedAt: context.reviewedAt,
    },
  });
  if (!prepared.ok) return false;
  return validateReviewFindingsConsistency({
    overallVerdict: prepared.findings.overallVerdict as string,
    blockingIssueCount: Array.isArray(prepared.findings.blockingIssues)
      ? prepared.findings.blockingIssues.length
      : 0,
  }).ok;
}
