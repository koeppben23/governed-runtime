/**
 * @module audit/proofgraph/gate
 * @description Pure ProofGraph gate decision.
 *
 * Encodes the gating invariants without touching workflow transitions: only
 * critical, evidence-backed `fact` claims are gate-eligible. `derived_signal`
 * and `hypothesis` claims are never gate-eligible — they remain advisory.
 *
 * The decision is computed and surfaced; it does not itself block a governed
 * transition.
 *
 * Gate now delegates to computeProofGraphEnforcement() as the single source
 * of truth — no duplicate traversal or second interpretation of claims.
 *
 * @version v2 — enforcement-projection is SSOT
 */

import type { ProofGraphSummary } from './summary.js';
import type { ProofGraphProjection } from '../../state/proofgraph.js';
import { AssertionBindingReasonCodeSchema } from '../../state/proofgraph.js';
import {
  assessProofGraphEvidence,
  type ProofEvidenceIntegrityInput,
} from './evidence-integrity.js';
import type { RiskTrigger, SessionState } from '../../state/schema.js';
import type { SpecificRiskTrigger } from '../../state/risk-trigger.js';
import type { AuthorizedClaimBinding } from '../../state/proofgraph-approval.js';
import { authorizedCriticalPlanClaimIds } from '../../state/proofgraph-approval-context.js';
import type { AssertionBindingReasonCode } from './assertion-evidence-binding.js';
import {
  computeProofGraphEnforcement,
  type EnforcementDecisionKind,
  type EnforcementReasonCode,
  type BlockingClaim,
} from './enforcement-projection.js';

function readDiagnosticsFromProjection(
  projection?: ProofGraphProjection,
): ReadonlyMap<string, AssertionBindingReasonCode> | undefined {
  if (!projection?.claimDiagnostics) return undefined;
  const map = new Map<string, AssertionBindingReasonCode>();
  for (const [key, value] of Object.entries(projection.claimDiagnostics)) {
    if (isValidBindingCode(value)) {
      map.set(key, value);
    }
  }
  return map.size > 0 ? map : undefined;
}

function isValidBindingCode(value: string): value is AssertionBindingReasonCode {
  return AssertionBindingReasonCodeSchema.safeParse(value).success;
}

/** The evaluated ProofGraph gate decision. */
export interface ProofGraphGateDecision {
  readonly gated: boolean;
  readonly blockingClaimIds: readonly string[];
  /** Per-claim blocking details with typed reason codes. */
  readonly blockingClaims: readonly BlockingClaim[];
  /** Enforcement reason code for the gate decision. */
  readonly reasonCode: EnforcementReasonCode;
  readonly reason: string;
  readonly kind: EnforcementDecisionKind;
  readonly relevantTriggers: readonly SpecificRiskTrigger[];
  /** Detected specific triggers without eligible claim coverage. */
  readonly uncoveredTriggers: readonly SpecificRiskTrigger[];
}

export interface ImplementationRiskAssessmentForGate {
  readonly implementationDigest: string;
  /**
   * Trigger taxonomy of the bound assessment. Required in the v8 state
   * contract; a trigger-less assessment cannot reach this gate because the
   * session schema rejects it before evaluation.
   */
  readonly riskTriggers: readonly RiskTrigger[];
}

export function isRiskAssessmentCurrent(
  assessment: ImplementationRiskAssessmentForGate | undefined,
  implementationDigest: string | undefined,
): boolean {
  return (
    assessment !== undefined &&
    implementationDigest !== undefined &&
    assessment.implementationDigest === implementationDigest
  );
}

function relevantTriggers(
  assessment: ImplementationRiskAssessmentForGate | undefined,
): readonly SpecificRiskTrigger[] {
  return (assessment?.riskTriggers ?? []).filter(
    (trigger): trigger is SpecificRiskTrigger => trigger !== 'ceremony_only',
  );
}

type ProofEvidenceAssessment = ReturnType<typeof assessProofGraphEvidence>;

function assessProjection(
  input: ProofEvidenceIntegrityInput & { readonly projection?: ProofGraphProjection },
): ProofEvidenceAssessment | undefined {
  return input.projection === undefined
    ? undefined
    : assessProofGraphEvidence(input.projection, input);
}

/** Projection diagnostics first, explicit input next, identity failures last. */
function mergeClaimDiagnostics(
  input: {
    readonly projection?: ProofGraphProjection;
    readonly claimDiagnostics?: ReadonlyMap<string, AssertionBindingReasonCode>;
  },
  assessment: ProofEvidenceAssessment | undefined,
): Map<string, AssertionBindingReasonCode> {
  const merged = new Map<string, AssertionBindingReasonCode>();
  for (const source of [
    readDiagnosticsFromProjection(input.projection),
    input.claimDiagnostics,
    assessment?.identityDiagnostics,
  ]) {
    if (source === undefined) continue;
    for (const [claimId, code] of source) merged.set(claimId, code);
  }
  return merged;
}

export function evaluateProofGraphGate(
  input: ProofEvidenceIntegrityInput & {
    readonly projection?: ProofGraphSummary['projection'];
    readonly authorizedCriticalClaimIds?: readonly string[];
    /**
     * Certificate-bound coverage relation from the current plan approval. The
     * projector trusts this relation, never the persisted projection's own
     * `coversRiskTriggers` entries.
     */
    readonly authorizedRiskTriggerCoverage?: ReadonlyMap<string, readonly SpecificRiskTrigger[]>;
    /** Expected certificate binding per authorized critical claim. */
    readonly authorizedClaimBindings?: ReadonlyMap<string, AuthorizedClaimBinding>;
    readonly certificateValid?: boolean;
    readonly riskAssessment?: ImplementationRiskAssessmentForGate | undefined;
    /** Per-claim binding diagnostics for enforcement surface. */
    readonly claimDiagnostics?: ReadonlyMap<string, AssertionBindingReasonCode>;
  },
): ProofGraphGateDecision {
  const triggers = relevantTriggers(input.riskAssessment);
  const assessment = assessProjection(input);
  const projection = assessment?.projection;

  // A current implementation requires a risk assessment bound to that exact
  // revision. A missing assessment is as unusable as a superseded one: the
  // enforcement projection owns the fail-closed decision for both. With no
  // implementation digest there is no revision to bind to, so the assessment
  // cannot be judged stale.
  const riskStale =
    input.implementationDigest !== undefined &&
    !isRiskAssessmentCurrent(input.riskAssessment, input.implementationDigest);

  const claimDiagnostics = mergeClaimDiagnostics(input, assessment);
  const enforcement = computeProofGraphEnforcement({
    contract: input.contract,
    ...(projection !== undefined ? { projection } : {}),
    ...(input.authorizedCriticalClaimIds !== undefined
      ? { authorizedCriticalClaimIds: input.authorizedCriticalClaimIds }
      : {}),
    ...(input.authorizedRiskTriggerCoverage !== undefined
      ? { authorizedRiskTriggerCoverage: input.authorizedRiskTriggerCoverage }
      : {}),
    ...(input.authorizedClaimBindings !== undefined
      ? { authorizedClaimBindings: input.authorizedClaimBindings }
      : {}),
    ...(input.certificateValid !== undefined ? { certificateValid: input.certificateValid } : {}),
    ...(input.implementationDigest !== undefined
      ? { implementationDigest: input.implementationDigest }
      : {}),
    riskAssessmentStale: riskStale,
    riskTriggers: triggers,
    ...(claimDiagnostics !== undefined ? { claimDiagnostics } : {}),
  });

  return {
    gated: !enforcement.satisfied,
    blockingClaimIds: enforcement.blockingClaims.map((b) => b.claimId),
    blockingClaims: enforcement.blockingClaims,
    reasonCode: enforcement.reasonCode,
    reason: enforcement.reason,
    kind: enforcement.decisionKind,
    relevantTriggers: triggers,
    uncoveredTriggers: enforcement.uncoveredTriggers,
  };
}

/**
 * Evaluate the ProofGraph gate directly from persisted session state, mirroring
 * the inputs the review-decision rail enforces. Read-only convenience for the
 * status surface — never a second gating authority.
 */
export function evaluateProofGraphGateFromState(state: SessionState): ProofGraphGateDecision {
  const authorization = authorizedCriticalPlanClaimIds(state);
  return evaluateProofGraphGate({
    contract: state.proofContract,
    validationAttempts: state.validationAttempts,
    implementationDigest: state.implementation?.digest,
    projection: state.proofGraph,
    authorizedCriticalClaimIds: authorization.kind === 'authorized' ? authorization.claimIds : [],
    ...(authorization.kind === 'authorized'
      ? { authorizedRiskTriggerCoverage: authorization.coverage }
      : {}),
    ...(authorization.kind === 'authorized'
      ? { authorizedClaimBindings: authorization.bindings }
      : {}),
    certificateValid: authorization.kind === 'authorized',
    ...(state.implementationRiskAssessment !== null
      ? { riskAssessment: state.implementationRiskAssessment }
      : {}),
  });
}
