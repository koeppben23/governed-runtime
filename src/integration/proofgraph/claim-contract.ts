/**
 * @module integration/proofgraph/claim-contract
 * @description Fail-closed claim-declaration contract for every write boundary (#762).
 *
 * A critical claim requires adversarial evidence to reach PROVEN
 * (materialize-contract.ts sets `adversarial: ['counterexample']` for it, and
 * audit/proofgraph/evaluate.ts returns NOT_VERIFIED when that is unmet). A
 * critical declaration WITHOUT a counterexample check is therefore structurally
 * unprovable: once the gate is unconditional it would block the final approval
 * forever, with no recovery available to the author.
 *
 * The same holds for a check id that is not active, an unknown structural
 * surface, or an unregistered mutation profile: each yields evidence that can
 * never resolve.
 *
 * This validator rejects those declarations at the moment they are authored,
 * where the error is actionable — never at the approval gate hours later. It is
 * deliberately NOT a persisted schema refinement: `SessionState.safeParse` runs
 * on read, so a refinement would make an already-persisted session unreadable
 * instead of rejecting a write.
 *
 * Both write boundaries share this module so the rules cannot drift apart, while
 * diagnostics keep each tool's PUBLIC field names.
 */

import type { TaskClass } from '../../state/schema.js';
import type { CounterexampleRequirement } from '../../state/proofgraph.js';

/** Write boundary a declaration arrived through; selects the public field names. */
export type ClaimContractSource = 'plan' | 'declare_contract';

/**
 * Normalized declaration under validation.
 *
 * `/declare-contract` derives its claim id from the statement, so `claimId` is
 * optional here and identity collisions are reported against the statement.
 */
export interface NormalizedClaimDeclaration {
  readonly claimId?: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly positiveCheckId: string;
  readonly counterexampleRequirement?: CounterexampleRequirement;
  readonly structuralSurface?: string;
  readonly mutationProfile?: string;
  /** Present only for plan declarations; architecture/contract flows omit it. */
  readonly authoritySectionId?: string;
}

export interface ClaimContractInput {
  readonly claims: readonly NormalizedClaimDeclaration[];
  readonly activeChecks: readonly string[];
  readonly allowedSurfaces: readonly string[];
  readonly allowedMutationProfiles: readonly string[];
  readonly source: ClaimContractSource;
}

export type ClaimContractResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'invalid';
      /** Public identity of the offending claim in the caller's own vocabulary. */
      readonly claimRef: string;
      /** Public field name as the caller knows it. */
      readonly field: string;
      readonly detail: string;
    };

/** Public field names per write boundary; diagnostics never leak internal names. */
const FIELD_LABELS: Readonly<Record<ClaimContractSource, Readonly<Record<string, string>>>> = {
  plan: {
    positiveCheckId: 'expectedCheckId',
    counterexampleRequirement: 'counterexampleRequirement',
    critical: 'critical',
    claimId: 'claimId',
    structuralSurface: 'structuralSurface',
    mutationProfile: 'mutationProfile',
    authoritySectionId: 'authoritySectionId',
  },
  declare_contract: {
    positiveCheckId: 'checkId',
    counterexampleRequirement: 'counterexampleRequirement',
    critical: 'critical',
    claimId: 'statement',
    structuralSurface: 'structuralSurface',
    mutationProfile: 'mutationProfile',
    authoritySectionId: 'authoritySectionId',
  },
};

function label(source: ClaimContractSource, field: string): string {
  return FIELD_LABELS[source][field] ?? field;
}

/** Identify a claim the way its author supplied it. */
function claimRef(source: ClaimContractSource, claim: NormalizedClaimDeclaration): string {
  return source === 'plan' && claim.claimId ? claim.claimId : claim.statement;
}

function invalid(
  source: ClaimContractSource,
  claim: NormalizedClaimDeclaration,
  field: string,
  detail: string,
): ClaimContractResult {
  return {
    kind: 'invalid',
    claimRef: claimRef(source, claim),
    field: label(source, field),
    detail,
  };
}

/** Rule 2: identity must be unique, or two declarations collapse into one claim. */
function checkUniqueIdentity(input: ClaimContractInput): ClaimContractResult | null {
  const seen = new Set<string>();
  for (const claim of input.claims) {
    const identity = claimRef(input.source, claim);
    if (seen.has(identity)) {
      return invalid(
        input.source,
        claim,
        'claimId',
        input.source === 'plan'
          ? 'duplicate claimId; every declaration needs its own identity'
          : 'duplicate statement; the claim id is derived from it, so two identical statements collapse into one claim',
      );
    }
    seen.add(identity);
  }
  return null;
}

/** Rule 3: a critical claim is only provable with executed adversarial evidence. */
function checkCriticalContract(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (!claim.critical) return null;
  if (!claim.counterexampleRequirement) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement',
      'a critical claim requires a counterexample requirement; without it the claim can never become PROVEN.',
    );
  }
  if (claim.counterexampleRequirement.checkId === claim.positiveCheckId) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement',
      'a critical claim requires a counterexample requirement distinct from its positive check.',
    );
  }
  return null;
}

/** Rule 4: an inactive check produces evidence that can never resolve. */
function checkCheckReferences(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  const active = new Set(input.activeChecks);
  const known = input.activeChecks.length > 0 ? input.activeChecks.join(', ') : 'none';
  if (!active.has(claim.positiveCheckId)) {
    return invalid(
      input.source,
      claim,
      'positiveCheckId',
      `'${claim.positiveCheckId}' is not an active check; active checks are: ${known}`,
    );
  }
  if (claim.counterexampleRequirement && !active.has(claim.counterexampleRequirement.checkId)) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement',
      `'${claim.counterexampleRequirement.checkId}' is not an active check; active checks are: ${known}`,
    );
  }
  return null;
}

/** Rule 5: an unregistered surface or profile yields permanently missing evidence. */
function checkRegistries(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (
    claim.structuralSurface !== undefined &&
    !input.allowedSurfaces.includes(claim.structuralSurface)
  ) {
    return invalid(
      input.source,
      claim,
      'structuralSurface',
      `'${claim.structuralSurface}' is not a registered structural surface; registered surfaces are: ${input.allowedSurfaces.join(', ')}`,
    );
  }
  if (
    claim.mutationProfile !== undefined &&
    !input.allowedMutationProfiles.includes(claim.mutationProfile)
  ) {
    return invalid(
      input.source,
      claim,
      'mutationProfile',
      `'${claim.mutationProfile}' is not a registered mutation profile; registered profiles are: ${input.allowedMutationProfiles.join(', ')}`,
    );
  }
  return null;
}

/** Rule 6 (plan only): a claim without a governing section has no provenance. */
function checkAuthoritySection(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (input.source !== 'plan') return null;
  if (claim.authoritySectionId !== undefined && claim.authoritySectionId.trim().length > 0) {
    return null;
  }
  return invalid(
    input.source,
    claim,
    'authoritySectionId',
    'a plan claim must name the governing plan section',
  );
}

/** Rule 7: counterexample requirement must include an assertion. */
function checkCounterexampleAssertion(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (claim.counterexampleRequirement && !claim.counterexampleRequirement.assertion) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.assertion',
      'counterexample requirement must include an assertion identity',
    );
  }
  return null;
}

/**
 * Validate the full claim set atomically.
 *
 * Returns on the FIRST violation so the author fixes one concrete problem at a
 * time. The caller must not persist, and must not compute any digest, unless
 * the result is `ok` — otherwise a certificate could bind a semantically
 * invalid claim set.
 */
export function validateProofClaimContract(input: ClaimContractInput): ClaimContractResult {
  const duplicate = checkUniqueIdentity(input);
  if (duplicate) return duplicate;

  for (const claim of input.claims) {
    const violation =
      checkCriticalContract(input, claim) ??
      checkCheckReferences(input, claim) ??
      checkRegistries(input, claim) ??
      checkAuthoritySection(input, claim) ??
      checkCounterexampleAssertion(input, claim);
    if (violation) return violation;
  }
  return { kind: 'ok' };
}

/**
 * Whether an implementation risk assessment still describes the current
 * revision. A superseded assessment must never justify a gate decision.
 */
/** Advisory-only projection of a heuristic pre-implementation risk signal. */
export interface HeuristicRiskWarning {
  readonly computedMinimumTaskClass: TaskClass;
  readonly assessedFrom: 'plan_target_paths';
  readonly assessedFileCount: number;
  readonly message: string;
}

/**
 * Heuristic pre-implementation warning for a plan that looks HIGH-RISK but
 * declares no critical claim.
 *
 * Deliberately advisory: `targetPaths` are a forecast, whereas the binding
 * classification comes from the implementation's actual `changedFiles`. Using a
 * forecast to gate would both block on incomplete path lists and be avoidable by
 * omitting them. This only spares the author a late, expensive recovery cycle.
 *
 * Returns null when there is nothing to warn about — absent target paths never
 * produce a warning.
 */
export function buildHeuristicRiskWarning(input: {
  readonly targetPaths: readonly string[] | undefined;
  readonly assessedTaskClass: TaskClass;
  readonly criticalClaimCount: number;
}): HeuristicRiskWarning | null {
  const paths = input.targetPaths ?? [];
  if (paths.length === 0) return null;
  if (input.assessedTaskClass !== 'HIGH-RISK') return null;
  if (input.criticalClaimCount > 0) return null;
  return {
    computedMinimumTaskClass: input.assessedTaskClass,
    assessedFrom: 'plan_target_paths',
    assessedFileCount: paths.length,
    message:
      'The declared target paths suggest a HIGH-RISK change, but this plan declares no critical claim. ' +
      'This is a heuristic forecast, not a classification: the binding assessment is derived from the ' +
      "implementation's actual changed files. If those confirm HIGH-RISK, the final evidence approval " +
      'will require at least one critical, adversarially checkable plan claim.',
  };
}
