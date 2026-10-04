/**
 * @module shared/presentation-vocabulary
 * @description Host-neutral presentation vocabulary shared by presentation,
 * telemetry, and the integration layer.
 *
 * These are pure value vocabularies. They never create workflow authority,
 * synthesize commands, encode host syntax, or derive state. They live in
 * shared/ so that telemetry does not need to import the presentation context.
 *
 * @version v1
 */

/**
 * Host-neutral semantic action identity.
 *
 * Describes WHAT the user needs to do independently from HOW a host invokes it.
 */
export type ActionIntent =
  | 'refresh_repository'
  | 'run_validation'
  | 'rerun_review'
  | 'inspect_status'
  | 'inspect_blocker'
  | 'request_changes'
  | 'approve'
  | 'reject'
  | 'export_result';

/**
 * Semantic form of a visible FlowGuard result. Presentation-only: arranges
 * authoritative projections but never derives workflow state, policy,
 * evidence, or routing.
 */
export type PresentationForm =
  'success' | 'blocked' | 'decision' | 'review_pending' | 'terminal' | 'diagnostic';

/**
 * Information density of a presentation surface. A presentation-composition
 * concept — never domain state, never persisted.
 */
export type PresentationDetailLevel = 'summary' | 'explanation' | 'diagnostic';

/** Visibility of an already-authorized presentation action. */
export type PresentationVisibility = 'recommended' | 'available';
