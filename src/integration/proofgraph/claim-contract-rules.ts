/**
 * @module integration/proofgraph/claim-contract-rules
 * @description Fail-closed claim-declaration rules for every write boundary (#762).
 *
 * A critical claim requires adversarial evidence to reach PROVEN. A plan
 * counterexample is therefore not satisfied by another green ordinary run: it
 * must declare the exact approved source variant that the bound assertion
 * detects. Rules also reject inactive check ids, unregistered surfaces or
 * mutation profiles, unreachable positive assertions, and evidence-role
 * collisions, because each produces evidence that can never resolve.
 *
 * These rules reject those declarations at the moment they are authored, where
 * the error is actionable — never at the approval gate hours later. They are
 * deliberately NOT a persisted schema refinement: `SessionState.safeParse` runs
 * on read, so a refinement would make an already-persisted session unreadable
 * instead of rejecting a write.
 *
 * Both write boundaries share this module so the rules cannot drift apart, while
 * diagnostics keep each tool's PUBLIC field names.
 */

import type { CounterexampleRequirement } from '../../state/proofgraph-approval.js';
import { normalizeClaimStatement } from '../../state/proofgraph-approval.js';
import type { SpecificRiskTrigger } from '../../state/risk-trigger.js';
import type { VerificationCandidate } from '../../state/discovery-schemas.js';
import { hasProvingMutationProvider } from './mutation-provider.js';
import { declaredEvidenceRolesCollide } from '../../audit/proofgraph/evidence-role-independence.js';
import type { AssertionIdentity } from '../../state/assertion-identity.js';
import {
  assertionCapabilityFailure,
  counterexampleCapabilityFailure,
} from './claim-assertion-capability.js';

/** Write boundary a declaration arrived through; selects the public field names. */
export type ClaimContractSource = 'plan' | 'declare_contract';

/**
 * Normalized declaration under validation.
 *
 * `/declare-contract` mints its claim id through the canonical identity
 * authority (`mintProofGraphClaimId` in `state/proofgraph-approval.ts`), so
 * `claimId` is optional here and identity collisions are reported against the
 * statement.
 */
export interface NormalizedClaimDeclaration {
  readonly claimId?: string;
  readonly statement: string;
  readonly critical: boolean;
  readonly claimScope: 'specific_behavior' | 'suite';
  readonly positiveCheckId: string;
  readonly expectedAssertion?: AssertionIdentity;
  readonly counterexampleRequirement?: CounterexampleRequirement;
  readonly structuralSurface?: string;
  readonly mutationProfile?: string;
  /**
   * Specific risk triggers this claim explicitly covers. Only a critical claim
   * can carry coverage; the relation is validated, never inferred.
   */
  readonly coversRiskTriggers?: readonly SpecificRiskTrigger[];
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

export interface ClaimContractRejectedDeclaration {
  readonly disposition: 'rejected_blocking' | 'rejected_non_blocking';
  readonly claim: NormalizedClaimDeclaration;
  readonly index: number;
  readonly result: Extract<ClaimContractResult, { kind: 'invalid' }>;
}

/**
 * Classification used by write boundaries with an explicit partial-acceptance
 * policy. Set-level invariants are never repaired by accepting one declaration
 * and dropping another.
 */
export interface ClaimContractBatchResult {
  readonly accepted: readonly {
    readonly claim: NormalizedClaimDeclaration;
    readonly index: number;
  }[];
  readonly rejectedNonBlocking: readonly ClaimContractRejectedDeclaration[];
  readonly rejectedBlocking: readonly ClaimContractRejectedDeclaration[];
  readonly setViolations: readonly Extract<ClaimContractResult, { kind: 'invalid' }>[];
}

/** Public field names per write boundary; diagnostics never leak internal names. */
const FIELD_LABELS: Readonly<Record<ClaimContractSource, Readonly<Record<string, string>>>> = {
  plan: {
    positiveCheckId: 'expectedCheckId',
    counterexampleRequirement: 'counterexampleRequirement',
    critical: 'critical',
    claimId: 'claimId',
    structuralSurface: 'structuralSurface',
    mutationProfile: 'mutationProfile',
    coversRiskTriggers: 'coversRiskTriggers',
    authoritySectionId: 'authoritySectionId',
  },
  declare_contract: {
    positiveCheckId: 'checkId',
    counterexampleRequirement: 'counterexampleRequirement',
    critical: 'critical',
    claimId: 'statement',
    structuralSurface: 'structuralSurface',
    mutationProfile: 'mutationProfile',
    coversRiskTriggers: 'coversRiskTriggers',
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

/**
 * Within-batch duplicate key. Plan declarations are identified by their minted
 * claimId; manual declarations are identified by the canonical normalized
 * statement key — the same key the identity authority seeds a manual claim id
 * with, so batch and merge collision rules cannot drift apart.
 */
function duplicateIdentityKey(
  source: ClaimContractSource,
  claim: NormalizedClaimDeclaration,
): string {
  return source === 'plan' && claim.claimId
    ? claim.claimId
    : normalizeClaimStatement(claim.statement);
}

/** Rule 2: identity must be unique, or two declarations collapse into one claim. */
export function checkUniqueIdentity(input: ClaimContractInput): ClaimContractResult | null {
  const seen = new Set<string>();
  for (const claim of input.claims) {
    const identity = duplicateIdentityKey(input.source, claim);
    if (seen.has(identity)) {
      return invalid(
        input.source,
        claim,
        'claimId',
        input.source === 'plan'
          ? 'duplicate claimId; every declaration needs its own identity'
          : 'duplicate statement; the claim id is derived from its normalized form, so two statements differing only in whitespace or casing collapse into one claim',
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

/**
 * Rule 3b: only a critical claim can cover specific risk triggers, and each
 * trigger may be declared at most once. A non-critical claim is never
 * gate-eligible, so its declared coverage could never satisfy the final risk
 * requirement.
 */
function checkRiskTriggerCoverage(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  const covered = claim.coversRiskTriggers;
  if (covered === undefined) return null;
  if (!claim.critical) {
    return invalid(
      input.source,
      claim,
      'coversRiskTriggers',
      'only a critical claim can cover specific risk triggers; a non-critical claim is never gate-eligible, so its coverage could never satisfy the trigger requirement.',
    );
  }
  if (new Set(covered).size !== covered.length) {
    return invalid(
      input.source,
      claim,
      'coversRiskTriggers',
      'duplicate risk triggers are not allowed; declare each covered trigger at most once.',
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

/** Rule 4b: one check cannot serve as both the positive and the adversarial evidence. */
function checkEvidenceRoleCollision(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (!declaredEvidenceRolesCollide(claim)) return null;
  return invalid(
    input.source,
    claim,
    'counterexampleRequirement',
    `the positive check and the counterexample check require different check identities AND different validation attempts; '${claim.positiveCheckId}' cannot serve both evidence roles, even when executed twice`,
  );
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

function resolveCounterexampleCandidate(
  candidates: readonly VerificationCandidate[],
  requirement: NonNullable<NormalizedClaimDeclaration['counterexampleRequirement']>,
): VerificationCandidate | undefined {
  const candidateId = requirement.kind === 'aggregate_check' ? requirement.candidateId : undefined;
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
  const requirement = claim.counterexampleRequirement;
  if (!requirement) return null;
  const failure = counterexampleCapabilityFailure({
    requirement,
    candidate: resolveCounterexampleCandidate(input.verificationCandidates, requirement),
    ...(input.aggregateFormatsByProvider !== undefined
      ? { aggregateFormatsByProvider: input.aggregateFormatsByProvider }
      : {}),
  });
  return failure === null
    ? null
    : invalid(input.source, claim, failure.field, failure.detail, 'unsatisfiable');
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
 * Rule 10: a `specific_behavior` claim must name at least one claim-specific
 * evidence binding — an assertion counterexample requirement, a structural
 * surface, or a mutation profile.
 *
 * Without one, only execution evidence (a passing check) can ever attach, and
 * the claim could be reported PROVEN by a check that never observed the
 * declared behavior (Run-9 F4). Critical claims without a requirement are
 * already blocked by Rule 3; this rule closes the non-critical gap and keeps
 * the diagnostic actionable at the write boundary.
 */
function checkSpecificityBinding(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (claim.claimScope !== 'specific_behavior') return null;
  if (
    claim.expectedAssertion !== undefined ||
    claim.counterexampleRequirement !== undefined ||
    claim.structuralSurface !== undefined ||
    claim.mutationProfile !== undefined
  ) {
    return null;
  }
  return invalid(
    input.source,
    claim,
    'counterexampleRequirement',
    'a specific_behavior claim requires at least one claim-specific evidence binding: ' +
      'an expectedAssertion, a counterexample requirement (assertion), a structuralSurface, or a mutationProfile; ' +
      'a passing check alone does not prove the declared behavior',
    'unsatisfiable',
  );
}

function checkPositiveAssertion(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  const expectedAssertion = claim.expectedAssertion;
  if (!expectedAssertion) return null;
  const candidates = input.verificationCandidates.filter((c) => c.kind === claim.positiveCheckId);
  if (candidates.length === 0)
    return invalid(
      input.source,
      claim,
      'expectedAssertion',
      `positive check '${claim.positiveCheckId}' has no active verification candidate`,
      'unsatisfiable',
    );
  const failures = candidates.map((candidate) =>
    assertionCapabilityFailure(candidate, expectedAssertion),
  );
  if (failures.some((failure) => failure === null)) return null;
  return invalid(
    input.source,
    claim,
    'expectedAssertion',
    failures[0]?.detail ?? 'the declared positive assertion is unreachable',
    'unsatisfiable',
  );
}

function checkFalsificationVariant(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): ClaimContractResult | null {
  if (input.source !== 'plan') return null;
  if (!claim.counterexampleRequirement || claim.counterexampleRequirement.variant) return null;
  return invalid(
    input.source,
    claim,
    'counterexampleRequirement.variant',
    'a counterexample requires an approved exact source variant (path, before, after); a second green standard run is not falsification evidence',
    'unsatisfiable',
  );
}

export function claimViolations(
  input: ClaimContractInput,
  claim: NormalizedClaimDeclaration,
): Extract<ClaimContractResult, { kind: 'invalid' }>[] {
  return [
    checkCriticalContract(input, claim),
    checkRiskTriggerCoverage(input, claim),
    checkCheckReferences(input, claim),
    checkRegistries(input, claim),
    checkMutationSatisfiability(input, claim),
    checkAuthoritySection(input, claim),
    checkSuitePositiveSatisfiability(input, claim),
    checkCounterexampleScope(input, claim),
    checkCounterexampleSatisfiability(input, claim),
    checkPositiveAssertion(input, claim),
    checkSpecificityBinding(input, claim),
    // Last: a more specific rule above (inactive check, unsupported capability,
    // scope mismatch) names the actionable defect when it already applies.
    checkEvidenceRoleCollision(input, claim),
    checkFalsificationVariant(input, claim),
  ].filter(
    (violation): violation is Extract<ClaimContractResult, { kind: 'invalid' }> =>
      violation !== null,
  );
}
