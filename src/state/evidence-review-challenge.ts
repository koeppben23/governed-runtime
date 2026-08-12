/**
 * @module evidence-review-challenge
 * @description Falsification-challenge domain: typed evidence references, the
 *              challenge schemas per reviewed-artifact kind, their outcome
 *              vocabularies, and challenge resolution evidence.
 *
 * Extracted from evidence-review.ts along the challenge domain boundary. This
 * module owns the canonical challenge contract; evidence-review.ts re-exports
 * it so consumers keep a single import surface.
 *
 * @version v1
 */

import { z } from 'zod';
import { ActorInfoSchema } from './evidence-identity.js';
import { MarkdownSectionPath } from './evidence-findings.js';

/** Digest-bound reference to a Plan or ADR section excerpt. */
export const PlanAdrSectionRef = z
  .object({
    kind: z.literal('plan_adr_section'),
    artifactKind: z.enum(['plan', 'adr']),
    artifactDigest: z.string().min(1),
    sectionPath: MarkdownSectionPath,
    excerptDigest: z.string().min(1),
  })
  .readonly();
export type PlanAdrSectionRef = z.infer<typeof PlanAdrSectionRef>;

/** Digest-bound reference to an implementation and its optional persisted diff. */
export const ImplementationRef = z
  .object({
    kind: z.literal('implementation'),
    implementationDigest: z.string().min(1),
    diffDigest: z.string().min(1).optional(),
  })
  .readonly();
export type ImplementationRef = z.infer<typeof ImplementationRef>;

/** Reference to an immutable validation-attempt authority record. */
export const ValidationAttemptRef = z
  .object({
    kind: z.literal('validation_attempt'),
    attemptId: z.string().uuid(),
  })
  .readonly();
export type ValidationAttemptRef = z.infer<typeof ValidationAttemptRef>;

/** Digest-bound reference to content reviewed outside a Plan, ADR, or implementation. */
export const ContentRef = z
  .object({
    kind: z.literal('content'),
    digest: z.string().min(1),
  })
  .readonly();
export type ContentRef = z.infer<typeof ContentRef>;

/** Typed evidence references permitted in a structured review challenge. */
export const ReviewChallengeEvidenceRef = z.discriminatedUnion('kind', [
  PlanAdrSectionRef,
  ImplementationRef,
  ValidationAttemptRef,
  ContentRef,
]);
export type ReviewChallengeEvidenceRef = z.infer<typeof ReviewChallengeEvidenceRef>;

/**
 * Reviewer-supplied correlation slug for a challenge.
 *
 * The reviewer never mints a challenge identity — the host does. This slug is
 * the reviewer's own handle for a challenge within a single payload; the host
 * maps it to the canonical `challengeId` during normalization and retains it so
 * the audit trail stays correlatable to the reviewer's original output.
 */
export const ChallengeClientReference = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-zA-Z0-9_-]+$/);

const ReviewChallengeBase = {
  challengeId: z.string().uuid(),
  obligationId: z.string().uuid(),
  clientReference: ChallengeClientReference.optional(),
  scenario: z.string().min(1),
  claim: z.string().min(1),
  locations: z.array(z.string().min(1)).min(1),
};

/**
 * Outcome vocabulary of a falsification-style challenge (design and content).
 *
 * Declared once and reused by every schema and by the reviewer prompt builder,
 * so the values a reviewer is TOLD to produce can never drift from the values
 * binding actually accepts.
 */
const FalsificationChallengeOutcome = z.enum(['supported', 'contradicted', 'not_verified']);

/** Outcome vocabulary of an implementation challenge (executed, not argued). */
const ImplementationChallengeOutcome = z.enum(['pass', 'fail', 'not_verified']);

const DesignChallenge = z.object({
  ...ReviewChallengeBase,
  kind: z.literal('design_challenge'),
  evidenceRefs: z.array(PlanAdrSectionRef).min(1),
  outcome: FalsificationChallengeOutcome,
});

const ImplementationChallenge = z.object({
  ...ReviewChallengeBase,
  kind: z.literal('implementation_challenge'),
  evidenceRefs: z.array(z.union([ImplementationRef, ValidationAttemptRef])).min(1),
  outcome: ImplementationChallengeOutcome,
});

const ContentChallenge = z.object({
  ...ReviewChallengeBase,
  kind: z.literal('content_challenge'),
  evidenceRefs: z.array(ContentRef).min(1),
  outcome: FalsificationChallengeOutcome,
});

/**
 * Canonical allowed `outcome` values per challenge kind.
 *
 * Derived from the schemas above rather than restated, so a prompt that lists
 * the vocabulary is structurally incapable of contradicting the binding gate.
 * A reviewer that is shown only a single example value has to guess the rest of
 * the enum, and a wrong guess fails binding with `schema_invalid`.
 */
export const REVIEW_CHALLENGE_OUTCOMES = {
  design_challenge: DesignChallenge.shape.outcome.options,
  implementation_challenge: ImplementationChallenge.shape.outcome.options,
  content_challenge: ContentChallenge.shape.outcome.options,
} as const;

/**
 * An evidence-bound falsification attempt. This is advisory evidence only;
 * challenge requirement and resolution enforcement are deliberately separate.
 */
export const ReviewChallenge = z.discriminatedUnion('kind', [
  DesignChallenge.readonly(),
  ImplementationChallenge.readonly(),
  ContentChallenge.readonly(),
]);
export type ReviewChallenge = z.infer<typeof ReviewChallenge>;

// ─── Reviewer Challenge Input (non-authoritative, pre-normalization) ──────────

/**
 * The challenge shape a reviewer subagent is asked to produce.
 *
 * Derived from the canonical {@link ReviewChallenge} by omitting the
 * host-assigned `challengeId`, so the reviewer-facing contract and the binding
 * authority can never drift apart. A hand-maintained copy previously declared a
 * single flat `outcome` enum, which could not express an implementation
 * challenge (`pass` / `fail`) at all.
 *
 * This type documents the contract; the canonical {@link ReviewFindings} schema
 * remains the sole runtime gate at binding time.
 */
export const ReviewerChallengeInput = z.discriminatedUnion('kind', [
  DesignChallenge.omit({ challengeId: true }).readonly(),
  ImplementationChallenge.omit({ challengeId: true }).readonly(),
  ContentChallenge.omit({ challengeId: true }).readonly(),
]);
export type ReviewerChallengeInput = z.infer<typeof ReviewerChallengeInput>;

/**
 * Advisory evidence that an implementation challenge was addressed by the
 * current implementation and its immutable post-implementation checks.
 * Resolution remains deliberately separate from review acceptance policy.
 */
export const ChallengeResolution = z
  .object({
    challengeId: z.string().uuid(),
    implementationDigest: z.string().min(1),
    validationAttemptIds: z.array(z.string().uuid()).min(1),
    resolvedAt: z.string().datetime(),
    /** Author evidence is a proposal only; it never resolves a challenge. */
    author: ActorInfoSchema.optional(),
  })
  .readonly();
export type ChallengeResolution = z.infer<typeof ChallengeResolution>;

/** An independent reviewer's verdict on a prior implementation challenge resolution. */
export const ChallengeResolutionVerdict = z
  .object({
    challengeId: z.string().uuid(),
    verdict: z.enum(['resolved', 'still_failing', 'not_verified']),
  })
  .readonly();
export type ChallengeResolutionVerdict = z.infer<typeof ChallengeResolutionVerdict>;
