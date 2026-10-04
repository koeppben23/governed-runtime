/**
 * @module integration/review/reviewer-contract
 * @description Reviewer-facing projection of the canonical model-output
 * authority `ReviewerFindingsInput` (src/state/evidence-review-input.ts).
 *
 * This module is a rendering helper, NOT a source of truth. Every enum value
 * and kind list is derived from the canonical Zod schemas at import time, so a
 * projection can never drift from the vocabulary that binding accepts. The
 * reviewer prompt grammar (finding-relation-grammar.ts) and the SDK JSON schema
 * (findings-schema.ts) render these values.
 */
import {
  ArtifactKind,
  FindingCategory,
  FindingSeverity,
  ReviewRevision,
} from '../../../state/evidence-findings.js';
import { LoopVerdict } from '../../../state/evidence-primitives.js';
import {
  ChallengeResolutionOutcome,
  REVIEW_CHALLENGE_OUTCOMES,
  ReviewerChallengeInput,
} from '../../../state/evidence-review-challenge.js';
import { ReviewSubjectAnchor } from '../../../state/evidence-findings.js';

export const SEVERITY_VALUES = FindingSeverity.options;

export const CATEGORY_VALUES = FindingCategory.options;

export const ARTIFACT_KIND_VALUES = ArtifactKind.options;

export const REVISION_VALUES = ReviewRevision.options;

export const OVERALL_VERDICT_VALUES = LoopVerdict.options;

export const CHALLENGE_OUTCOMES = REVIEW_CHALLENGE_OUTCOMES;

export const CHALLENGE_RESOLUTION_VERDICT_VALUES = ChallengeResolutionOutcome.options;

export const ANCHOR_KINDS = ReviewSubjectAnchor.options.map(
  (anchor) => anchor.unwrap().shape.kind.value,
);

export const CHALLENGE_KINDS = ReviewerChallengeInput.options.map(
  (challenge) => challenge.unwrap().shape.kind.value,
);
