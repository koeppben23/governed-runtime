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
import type { V2CounterexampleRequirement } from '../../state/proofgraph-approval.js';
import type { VerificationCandidate } from '../../state/discovery-schemas.js';
import {
  ASSERTION_FORMATS_BY_PROVIDER,
  ASSERTION_CODEC_BY_PROVIDER,
  AGGREGATE_FORMATS_BY_PROVIDER,
} from '../../providers/registry.js';
import { hasProvingMutationProvider } from './mutation-provider.js';

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
  readonly claimScope: 'specific_behavior' | 'suite';
  readonly positiveCheckId: string;
  readonly counterexampleRequirement?: V2CounterexampleRequirement;
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
  readonly verificationCandidates: readonly VerificationCandidate[];
  /** Derived provider-registry capability map; defaults to the installed registry. */
  readonly aggregateFormatsByProvider?: ReadonlyMap<string, ReadonlySet<string>>;
  readonly source: ClaimContractSource;
}

export type ClaimContractFailureKind = 'contract_incomplete' | 'unsatisfiable';

export type ClaimContractResult =
  | { readonly kind: 'ok' }
  | {
      readonly kind: 'invalid';
      readonly failureKind: ClaimContractFailureKind;
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
  failureKind: ClaimContractFailureKind = 'contract_incomplete',
): ClaimContractResult {
  return {
    kind: 'invalid',
    failureKind,
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

/** Rule 5b: a mutationProfile creates a fault_injection positive requirement.
 *  When no FlowGuard-executed mutation provider exists, the claim can never be
 *  PROVEN — external_self_reported evidence is filtered from positive proof.
 *  The declaration must be rejected before it creates an unsatisfiable contract. */
function checkMutationSatisfiability(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (claim.mutationProfile === undefined) return null;
  if (hasProvingMutationProvider()) return null;
  return invalid(
    input.source,
    claim,
    'mutationProfile',
    `mutation profile '${claim.mutationProfile}' requires fault_injection evidence, ` +
      'but no FlowGuard-executed mutation provider is registered; ' +
      'externally self-reported mutation evidence cannot satisfy positive proof requirements',
    'unsatisfiable',
  );
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

/** Rule 7: scope and falsification requirement must be compatible. */
function checkCounterexampleScope(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  const requirement = claim.counterexampleRequirement;
  if (!requirement) return null;
  const expectedKind = claim.claimScope === 'suite' ? 'aggregate_check' : 'assertion';
  if (requirement.kind !== expectedKind) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement',
      `${claim.claimScope} claims require a ${expectedKind} counterexample requirement`,
    );
  }
  return null;
}

function checkAggregateCounterexampleCapability(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
  requirement: NonNullable<NormalizedClaimDeclaration['counterexampleRequirement']>,
  candidate: VerificationCandidate,
): ClaimContractResult | null {
  if (requirement.kind !== 'aggregate_check') return null;
  if (candidate.assertionCapability !== 'structured') {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.checkId',
      `check '${requirement.checkId}' has assertionCapability='${candidate.assertionCapability}', cannot produce aggregate evidence`,
      'unsatisfiable',
    );
  }
  const report = candidate.assertionReport;
  const formats =
    report &&
    (input.aggregateFormatsByProvider ?? AGGREGATE_FORMATS_BY_PROVIDER).get(report.providerId);
  if (
    report &&
    formats?.has(report.format) &&
    candidate.fullCheckScopeAttestation === 'full_check'
  ) {
    return null;
  }
  if (report && formats?.has(report.format)) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement',
      `check '${requirement.checkId}' has aggregate parsing capability but no explicit full-check scope completeness attestation`,
      'unsatisfiable',
    );
  }
  return invalid(
    input.source,
    claim,
    'counterexampleRequirement',
    `check '${requirement.checkId}' has no registered aggregate counterexample capability for its assertion report provider and format`,
    'unsatisfiable',
  );
}

function resolveCounterexampleCandidate(
  candidates: readonly VerificationCandidate[],
  requirement: NonNullable<NormalizedClaimDeclaration['counterexampleRequirement']>,
): VerificationCandidate | undefined {
  const candidateId = 'candidateId' in requirement ? requirement.candidateId : undefined;
  return candidateId
    ? candidates.find(
        (candidate) =>
          candidate.candidateId === candidateId && candidate.kind === requirement.checkId,
      )
    : candidates.find((candidate) => candidate.kind === requirement.checkId);
}

/** Rule 8: counterexample check must provide the declared capability. */
function checkCounterexampleSatisfiability(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (!claim.critical) return null;
  const req = claim.counterexampleRequirement;
  if (!req) return null;

  const candidate = resolveCounterexampleCandidate(input.verificationCandidates, req);
  if (!candidate) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.checkId',
      `counterexample check '${req.checkId}' is not in active verification candidates`,
      'unsatisfiable',
    );
  }

  if (req.kind === 'aggregate_check') {
    return checkAggregateCounterexampleCapability(input, claim, req, candidate);
  }

  const assertionRequirement = req;

  if (candidate.assertionCapability !== 'structured') {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.checkId',
      `check '${assertionRequirement.checkId}' has assertionCapability='${candidate.assertionCapability}', cannot produce assertion evidence for provider '${assertionRequirement.assertion.providerId}'`,
      'unsatisfiable',
    );
  }

  const report = candidate.assertionReport;
  if (!report) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement',
      `check '${req.checkId}' is structured but has no assertionReport`,
      'unsatisfiable',
    );
  }

  if (report.providerId !== assertionRequirement.assertion.providerId) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.assertion.providerId',
      `check produces assertions from '${report.providerId}', claim requires '${assertionRequirement.assertion.providerId}'`,
      'unsatisfiable',
    );
  }

  const formats = ASSERTION_FORMATS_BY_PROVIDER.get(assertionRequirement.assertion.providerId);
  if (!formats || !formats.has(report.format)) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.assertion.providerId',
      `format '${report.format}' from provider '${assertionRequirement.assertion.providerId}' is not assertion-binding-capable`,
      'unsatisfiable',
    );
  }

  const codec = ASSERTION_CODEC_BY_PROVIDER.get(assertionRequirement.assertion.providerId);
  if (!codec) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.assertion.providerId',
      `provider '${assertionRequirement.assertion.providerId}' has no registered identity codec`,
      'unsatisfiable',
    );
  }

  if (!codec.validateLocalId(assertionRequirement.assertion.localId)) {
    return invalid(
      input.source,
      claim,
      'counterexampleRequirement.assertion.localId',
      `'${assertionRequirement.assertion.localId}' is not a valid assertion identity for provider '${assertionRequirement.assertion.providerId}'`,
      'unsatisfiable',
    );
  }

  return null;
}

/** Rule 9: a suite claim requires a structurally reachable positive full-suite path. */
function checkSuitePositiveSatisfiability(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (claim.claimScope !== 'suite') return null;

  const candidates = input.verificationCandidates.filter((c) => c.kind === claim.positiveCheckId);

  if (candidates.length === 0) {
    return invalid(
      input.source,
      claim,
      'positiveCheckId',
      `suite claim requires an active verification candidate for check '${claim.positiveCheckId}'`,
      'unsatisfiable',
    );
  }

  const suiteCandidate = candidates.find(
    (c) => c.assertionCapability === 'structured' && c.fullCheckScopeAttestation === 'full_check',
  );

  if (!suiteCandidate) {
    const best = candidates.find((c) => c.assertionCapability === 'structured');
    if (!best) {
      return invalid(
        input.source,
        claim,
        'positiveCheckId',
        `no structured assertion-capable candidate for check '${claim.positiveCheckId}' (${candidates.length} candidate(s), all assertionCapability='unsupported'); suite claims require structured full-suite evidence`,
        'unsatisfiable',
      );
    }
    const candidateLabel = best.candidateId
      ? `candidate '${best.candidateId}'`
      : `check '${claim.positiveCheckId}'`;
    return invalid(
      input.source,
      claim,
      'positiveCheckId',
      `${candidateLabel} is structured but lacks explicit full-check scope completeness attestation required for suite claims; provider '${best.source}' does not attest full-suite coverage`,
      'unsatisfiable',
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
      checkMutationSatisfiability(input, claim) ??
      checkAuthoritySection(input, claim) ??
      checkSuitePositiveSatisfiability(input, claim) ??
      checkCounterexampleScope(input, claim) ??
      checkCounterexampleSatisfiability(input, claim);
    if (violation) return violation;
  }
  return { kind: 'ok' };
}

/**
 * Format a claim contract violation into a blocked result.
 *
 * Maps `failureKind` to the appropriate reason code. Both /plan and
 * /declare-contract must use this function so reason-code selection
 * cannot drift between write boundaries.
 */
export function formatClaimContractViolation(
  result: ClaimContractResult & { kind: 'invalid' },
  formatBlocked: (code: string, params: Record<string, string>) => string,
): string {
  return result.failureKind === 'unsatisfiable'
    ? formatBlocked('PROOFGRAPH_CLAIM_UNSATISFIABLE', {
        claimRef: result.claimRef,
        field: result.field,
        detail: result.detail,
      })
    : formatBlocked('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE', {
        claimRef: result.claimRef,
        field: result.field,
        detail: result.detail,
      });
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
