/**
 * @module presentation/human-projection
 * @description Canonical Human Projection types for FlowGuard user surfaces.
 *
 * The Human Projection is a READ-ONLY, presentation-owned layer between the
 * canonical domain state and the rendered PresentationDocument. It explains
 * governance outcomes to a human (why something is blocked, what to do next)
 * without ever becoming a second authority:
 *
 * - It never re-derives blocker, readiness, evidence, or gate decisions.
 * - It only classifies and re-orders facts that already exist canonically.
 * - A default (lossy) presentation must remain traceable to canonical
 *   semantics through the diagnostic surface.
 *
 * Command/invocation metadata is NOT part of this layer. The canonical
 * public-command catalogue is owned by the command layer
 * (`integration/installed-commands.ts`). The Human Projection defines no
 * slash-command table and duplicates no invocation metadata.
 *
 * Semantic action bindings (`impact`, future intent/action projections) are
 * ONLY introduced where an explicit, canonical source carries them — never
 * inferred from prose or from a coarse technical taxonomy.
 *
 * Pure type + pure function layer. Imports only presentation-layer types.
 *
 * @version v1
 */

/** Semantic impact a governance state has on the developer's workflow. */
export type UserImpact =
  | 'workflow_blocked'
  | 'verification_incomplete'
  | 'review_required'
  | 'decision_required'
  | 'degraded_only';

/**
 * Human-readable explanation of a governance state.
 *
 * `headline` is the deterministic summary of the state. For migrated reason
 * codes the copy authority (`reason-copy.ts`) supplies `explanation` and
 * `impact`; unmigrated states carry no explanation and the projection fails
 * incomplete rather than invent prose. `impact` is present only for states
 * with an explicit, canonical impact mapping.
 */
export interface HumanExplanation {
  readonly headline: string;
  readonly explanation?: string;
  readonly impact?: UserImpact;
}

/**
 * Projected recovery guidance for a governance state.
 *
 * `primary` is the first, most direct action; `secondary` holds the remaining
 * ordered steps. `diagnosticNotes` carry diagnostic-only detail that must not
 * be rendered in the default surface. `primary` is never an empty string —
 * the recovery contract guarantees at least one step, and the projection
 * enforces that invariant.
 */
export interface RecoveryProjection {
  readonly primary: string;
  readonly secondary: readonly string[];
  readonly diagnosticNotes?: string;
}
