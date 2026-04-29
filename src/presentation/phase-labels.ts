/**
 * @module presentation/phase-labels
 * @description Human-readable phase label projection.
 *
 * Pure presentation layer. The canonical Phase enum in src/state/schema.ts
 * remains the single runtime authority. These labels are used ONLY in
 * status projections and user-facing output — never in state, machine,
 * policy, or audit.
 *
 * TypeScript enforces exhaustiveness via `satisfies Record<Phase, string>`.
 * If a new phase is added to the enum, this file must be updated or tsc fails.
 *
 * Convention: labels are short, sentence-case, and product-oriented.
 * They must not be SCREAMING_SNAKE_CASE.
 *
 * @version v1
 */

import type { Phase } from '../state/schema.js';

export const PHASE_LABELS = {
  READY: 'Ready',
  TICKET: 'Task captured',
  PLAN: 'Planning',
  PLAN_REVIEW: 'Ready for plan approval',
  VALIDATION: 'Validation',
  IMPLEMENTATION: 'Implementation in progress',
  IMPL_REVIEW: 'Ready for evidence review',
  EVIDENCE_REVIEW: 'Ready for final review',
  COMPLETE: 'Complete',
  ARCHITECTURE: 'Architecture in progress',
  ARCH_REVIEW: 'Ready for architecture review',
  ARCH_COMPLETE: 'Architecture complete',
  REVIEW: 'Compliance review',
  REVIEW_COMPLETE: 'Review complete',
} satisfies Record<Phase, string>;

/**
 * Derive TypeScript type from the labels record.
 * This ensures Phase and PHASE_LABELS stay synchronised at compile time.
 */
export type PhaseLabel = (typeof PHASE_LABELS)[Phase];
