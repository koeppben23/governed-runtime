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
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import { normalizeChallenges } from './normalize.js';

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
    };
  }
  return { ok: true, findings: hostAttestationFindings };
}
