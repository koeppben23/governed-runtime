/**
 * @module integration/review/reviewer-contract
 * @description Reviewer-facing projection of the canonical model-output
 * authority `ReviewerFindingsInput` (src/state/evidence-review-input.ts).
 *
 * This module is a rendering helper, NOT a source of truth. It holds the enum
 * values and anchor shape descriptors that the reviewer prompt grammar
 * (finding-relation-grammar.ts) and the SDK JSON schema (findings-schema.ts)
 * render for the model. The canonical contract is the Zod authority; parity is
 * enforced behaviorally by reviewer-contract.test.ts and
 * findings-schema-drift.test.ts, which validate these projections against the
 * canonical Zod schemas.
 */
export const SEVERITY_VALUES = ['critical', 'major', 'minor'] as const;

export const CATEGORY_VALUES = [
  'completeness',
  'correctness',
  'feasibility',
  'risk',
  'quality',
] as const;

export const ANCHOR_KINDS = [
  'repository_location',
  'artifact_section',
  'content',
  'implementation',
] as const;

export const REVISION_VALUES = ['base', 'head'] as const;

export const CHALLENGE_KINDS = [
  'design_challenge',
  'implementation_challenge',
  'content_challenge',
] as const;

export const OVERALL_VERDICT_VALUES = ['accept', 'changes_requested', 'unable_to_review'] as const;

/** Canonical shape descriptors for each review subject anchor kind. */
export interface AnchorShapeDescriptor {
  readonly kind: (typeof ANCHOR_KINDS)[number];
  readonly requiredFields: readonly string[];
}

export const REVIEWER_ANCHOR_SHAPES: Record<(typeof ANCHOR_KINDS)[number], AnchorShapeDescriptor> =
  {
    repository_location: { kind: 'repository_location', requiredFields: ['kind', 'location'] },
    artifact_section: {
      kind: 'artifact_section',
      requiredFields: ['kind', 'artifactKind', 'artifactDigest', 'sectionPath'],
    },
    content: { kind: 'content', requiredFields: ['kind', 'subjectDigest'] },
    implementation: {
      kind: 'implementation',
      requiredFields: ['kind', 'implementationDigest'],
    },
  };

/** Canonical shape descriptor for each challenge kind. */
export interface ChallengeShapeDescriptor {
  readonly kind: (typeof CHALLENGE_KINDS)[number];
}

export const REVIEWER_CHALLENGE_SHAPES: Record<
  (typeof CHALLENGE_KINDS)[number],
  ChallengeShapeDescriptor
> = {
  design_challenge: { kind: 'design_challenge' },
  implementation_challenge: { kind: 'implementation_challenge' },
  content_challenge: { kind: 'content_challenge' },
};
