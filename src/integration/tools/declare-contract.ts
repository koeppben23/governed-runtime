/**
 * @module integration/tools/declare-contract
 * @description flowguard_declare_contract - declare evidence-bound ProofGraph claims.
 *
 * The declaration path that makes the ProofGraph non-dormant: an operator/agent
 * names the claims a change asserts, each covered by an implementation
 * validation attempt (by checkId) at the current revision. Governing provenance
 * is resolved SEPARATELY from the cited approved authority (ticket/plan/ADR); a
 * claim is `fact` only when an approved authority resolves, otherwise it is a
 * `hypothesis` surfaced as `NOT_VERIFIED`. Evidence binding stays fail-closed -
 * an unsourced claim is rejected, never recorded - and the tool persists the
 * contract, then derives + persists the ProofGraph projection.
 *
 * Advisory: its claims carry no approval certificate, so they are never
 * gate-eligible; it records evidence-bound claims and never alters review acceptance,
 * which remains owned by ReviewFindings, obligations, attestations, and policy.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';

import type { Phase, SessionState } from '../../state/schema.js';
import { CounterexampleRequirement } from '../../state/proofgraph.js';
import type {
  CounterexampleRequirement as CounterexampleRequirementType,
  DeclaredClaim,
} from '../../state/proofgraph.js';
import type { ProofProviderKind } from '../../state/proofgraph-primitives.js';
import type { ClaimAuthorityRef } from '../../state/proofgraph-refs.js';
import {
  SURFACE_COMMAND_REGISTRATION,
  SURFACE_CONFIG_DEFAULTS,
  STRUCTURAL_SURFACE_IDS,
} from '../proofgraph/structural-provider.js';
import { validateProofClaimContract } from '../proofgraph/claim-contract.js';
import {
  MUTATION_PROFILE_IDS,
  resolveVerifiedMutationAttempt,
  resolveVerifiedMutationVerdicts,
  type VerifiedMutationVerdicts,
} from '../proofgraph/mutation-provider.js';

/** Declarable mutation profile ids as a non-empty tuple for the Zod enum. */
const MUTATION_PROFILE_ENUM = MUTATION_PROFILE_IDS as [string, ...string[]];
import { refreshProofGraph } from '../proofgraph/refresh.js';
import type { ToolDefinition } from './helpers.js';
import {
  appendNextAction,
  formatBlocked,
  formatError,
  getWorktree,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
} from './helpers.js';

/** Phases in which contract declaration is admissible (implementation evidence + attempts exist). */
const DECLARE_CONTRACT_PHASES: ReadonlySet<Phase> = new Set<Phase>([
  'IMPL_VALIDATION',
  'IMPL_REVIEW',
]);

/** RFC 4122 DNS namespace, used to derive a stable UUIDv5 per claim statement. */
const CLAIM_NAMESPACE = Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex');

/** Deterministic UUIDv5 for a claim statement (stable claimId across evaluations). */
function claimIdFor(statement: string): string {
  const hash = crypto.createHash('sha1').update(CLAIM_NAMESPACE).update(statement, 'utf8').digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // RFC 4122 variant
  const hex = hash.subarray(0, 16).toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** A digest-bound reference to an executed validation attempt. */
type ValidationAttemptRef = { readonly kind: 'validation_attempt'; readonly attemptId: string };

/** Approved governing sources a claim may cite, resolved from session evidence. */
type AuthoritySource = 'ticket' | 'plan' | 'architecture';

/**
 * Resolve a claim's cited governing authority to a digest-bound reference, or
 * `null` when no authority was cited or the cited artifact is absent. A `null`
 * result makes the claim an assumption (surfaced as `NOT_VERIFIED`), never a
 * governing `fact`. Validation evidence is deliberately NOT an authority source.
 */
function resolveAuthority(
  state: SessionState,
  source: AuthoritySource | undefined,
): ClaimAuthorityRef | null {
  switch (source) {
    case 'ticket':
      return state.ticket ? { kind: 'approved_ticket', ticketDigest: state.ticket.digest } : null;
    case 'plan':
      return state.plan
        ? { kind: 'canonical_authority', authorityId: 'plan', digest: state.plan.current.digest }
        : null;
    case 'architecture':
      return state.architecture
        ? {
            kind: 'canonical_authority',
            authorityId: 'architecture',
            digest: state.architecture.digest,
          }
        : null;
    case undefined:
      return null;
  }
}

/**
 * The latest implementation-scoped validation attempt for `checkId` at `digest`,
 * or undefined when the check has no attempt at the current revision.
 */
function resolveImplAttempt(
  attempts: SessionState['validationAttempts'],
  checkId: string,
  digest: string,
): SessionState['validationAttempts'][number] | undefined {
  return [...attempts]
    .reverse()
    .find(
      (a) =>
        a.scope === 'implementation' &&
        a.implementationDigest === digest &&
        a.result.checkId === checkId,
    );
}

/** Raw claim input shape from the tool arguments. */
type RawClaim = {
  statement: string;
  checkId: string;
  critical: boolean;
  counterexampleCheckId?: string;
  authority?: AuthoritySource;
  structuralSurface?: string;
  mutationProfile?: string;
  counterexampleRequirement?: CounterexampleRequirementType;
};

/**
 * Build the optional evidence references a claim opts into (structural surface,
 * mutation profile) and the provider kinds they make REQUIRED.
 *
 * Returns the unresolved profile id when a declared mutation profile has no
 * digest-verified attempt, so the declaration fails closed instead of persisting
 * a reference that could never be satisfied.
 */
function buildOptionalEvidence(
  state: SessionState,
  rc: RawClaim,
  digest: string,
  verdicts: VerifiedMutationVerdicts,
):
  | {
      readonly refs: DeclaredClaim['evidenceRefs'][number][];
      readonly positive: ProofProviderKind[];
    }
  | { readonly unresolvedProfileId: string } {
  const refs: DeclaredClaim['evidenceRefs'][number][] = [];
  const positive: ProofProviderKind[] = [];
  // A declared structural surface becomes required positive evidence, so a
  // claim cannot be proven while its consistency assertion is failing/stale.
  if (rc.structuralSurface !== undefined) {
    refs.push({ kind: 'structural_surface', surfaceId: rc.structuralSurface });
    positive.push(
      rc.structuralSurface === SURFACE_CONFIG_DEFAULTS ? 'schema_compare' : 'structural_assertion',
    );
  }
  // A declared mutation profile is resolved to a CONCRETE, digest-verified
  // attempt, so surviving mutants (or a missing run) keep the claim unproven.
  if (rc.mutationProfile !== undefined) {
    const attempt = resolveVerifiedMutationAttempt(
      state.mutationAttempts,
      rc.mutationProfile,
      digest,
      verdicts,
    );
    if (attempt === null) return { unresolvedProfileId: rc.mutationProfile };
    refs.push({
      kind: 'mutation_attempt',
      attemptId: attempt.attemptId,
      profileId: rc.mutationProfile,
    });
    positive.push('fault_injection');
  }
  return { refs, positive };
}

/**
 * Resolve raw claim inputs into DeclaredClaims. Evidence (the covering check and
 * optional counterexample check) is bound fail-closed to implementation attempts
 * at `digest`. Governing provenance is resolved SEPARATELY from the cited
 * approved authority: a claim is `fact` only when an approved authority resolves;
 * otherwise it is a `hypothesis` with `null` provenance (surfaced NOT_VERIFIED).
 * Returns the built claims, the first checkId that could not resolve, or the
 * first mutation profile with no digest-verified attempt at this revision.
 */
function buildDeclaredClaims(
  state: SessionState,
  rawClaims: readonly RawClaim[],
  digest: string,
  verdicts: VerifiedMutationVerdicts,
):
  | { readonly claims: DeclaredClaim[] }
  | { readonly unresolvedCheckId: string }
  | { readonly unresolvedProfileId: string } {
  const claims: DeclaredClaim[] = [];
  for (const rc of rawClaims) {
    const evidence = resolveImplAttempt(state.validationAttempts, rc.checkId, digest);
    if (evidence === undefined) return { unresolvedCheckId: rc.checkId };
    const evidenceRef: ValidationAttemptRef = {
      kind: 'validation_attempt',
      attemptId: evidence.attemptId,
    };
    const counterexampleRefs: ValidationAttemptRef[] = [];
    if (rc.counterexampleCheckId !== undefined) {
      const counterexample = resolveImplAttempt(
        state.validationAttempts,
        rc.counterexampleCheckId,
        digest,
      );
      if (counterexample === undefined) return { unresolvedCheckId: rc.counterexampleCheckId };
      counterexampleRefs.push({ kind: 'validation_attempt', attemptId: counterexample.attemptId });
    }
    const provenance = resolveAuthority(state, rc.authority);
    const isFact = provenance !== null;
    const critical = rc.critical;
    const optional = buildOptionalEvidence(state, rc, digest, verdicts);
    if ('unresolvedProfileId' in optional) return optional;
    const evidenceRefs: DeclaredClaim['evidenceRefs'][number][] = [evidenceRef, ...optional.refs];
    const positive: ProofProviderKind[] = ['executed_test', ...optional.positive];
    claims.push({
      claimId: claimIdFor(rc.statement),
      statement: rc.statement,
      // No auto-`fact`: classification follows the resolved governing authority.
      signalClass: isFact ? 'fact' : 'hypothesis',
      critical,
      provenance,
      evidenceRefs,
      counterexampleRefs,
      // A critical fact claim must survive an executed counterexample before it
      // may be PROVEN; a missing/unresolved counterexample keeps it NOT_VERIFIED.
      requiredEvidence: {
        positive,
        adversarial: critical && isFact ? ['counterexample' as const] : [],
      },
      counterexampleRequirement: rc.counterexampleRequirement,
    });
  }
  return { claims };
}

/**
 * Reject a claim set that could never become PROVEN (#762).
 *
 * `critical` is required here rather than defaulted: an omitted field must never
 * silently produce a claim that can block the final approval.
 */
function validateDeclaredClaimContract(
  rawClaims: readonly RawClaim[],
  state: SessionState,
): string | null {
  const result = validateProofClaimContract({
    source: 'declare_contract',
    activeChecks: state.activeChecks,
    allowedSurfaces: STRUCTURAL_SURFACE_IDS,
    allowedMutationProfiles: MUTATION_PROFILE_IDS,
    claims: rawClaims.map((claim) => ({
      statement: claim.statement,
      critical: claim.critical,
      positiveCheckId: claim.checkId,
      counterexampleCheckId: claim.counterexampleCheckId,
      structuralSurface: claim.structuralSurface,
      mutationProfile: claim.mutationProfile,
    })),
  });
  if (result.kind === 'ok') return null;
  return formatBlocked('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE', {
    claimRef: result.claimRef,
    field: result.field,
    detail: result.detail,
  });
}

/**
 * Gate assertion-mode counterexample requirements: the session must have a
 * verification candidate with structured assertion capability matching the
 * requirement's checkId.  For assertion mode, the assertionId prefix must
 * also match the candidate's report format.
 */
function validateAssertionCapabilityGate(
  rawClaims: readonly RawClaim[],
  state: SessionState,
): string | null {
  const PREFIX_FORMAT_MAP: Record<string, string> = {
    'junit:': 'junit_xml',
    'vitest:': 'vitest_json',
    'jest:': 'jest_json',
    'go:': 'go_test_json',
  };

  for (const declaration of rawClaims) {
    const requirement = declaration.counterexampleRequirement;
    if (!requirement) continue;

    const candidate = state.verificationCandidates?.find(
      (c) => c.kind === requirement.checkId && c.assertionCapability === 'structured',
    );
    if (!candidate) {
      return formatBlocked('UNSUPPORTED_ASSERTION_CAPABILITY', {
        reason: `Verification check '${requirement.checkId}' does not support structured assertion evidence for counterexample binding.`,
      });
    }

    if (requirement.mode === 'assertion') {
      const prefix = Object.keys(PREFIX_FORMAT_MAP).find((p) =>
        requirement.assertionId.startsWith(p),
      );
      if (!prefix) {
        return formatBlocked('UNSUPPORTED_ASSERTION_CAPABILITY', {
          reason: `Assertion ID '${requirement.assertionId}' has an unrecognized prefix. Supported: junit:, vitest:, jest:, go:.`,
        });
      }
      const expectedFormat = PREFIX_FORMAT_MAP[prefix]!;
      if (
        (candidate as { assertionReport?: { format: string } }).assertionReport?.format !==
        expectedFormat
      ) {
        return formatBlocked('UNSUPPORTED_ASSERTION_CAPABILITY', {
          reason: `Assertion format mismatch: '${requirement.assertionId}' prefix requires '${expectedFormat}' but candidate has '${(candidate as { assertionReport?: { format: string } }).assertionReport?.format}'.`,
        });
      }
    }
  }
  return null;
}

/**
 * Reject a manual declaration that would replace an existing claim identity.
 * Manual ids are derived from statements, so check them before resolving any
 * evidence providers or mutation reports.
 */
function validateMergedClaimIds(
  rawClaims: readonly RawClaim[],
  state: SessionState,
): string | null {
  const existingIds = new Set((state.proofContract?.claims ?? []).map((claim) => claim.claimId));
  const requestedIds = new Set<string>();
  for (const claim of rawClaims) {
    const derivedClaimId = claimIdFor(claim.statement);
    if (existingIds.has(derivedClaimId) || requestedIds.has(derivedClaimId)) {
      return formatBlocked('PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE', {
        claimRef: claim.statement,
        field: 'statement',
        detail: `derives claimId '${derivedClaimId}', which already exists in the current ProofGraph contract`,
      });
    }
    requestedIds.add(derivedClaimId);
  }
  return null;
}

export const declare_contract: ToolDefinition = {
  description:
    'Declare ProofGraph contract claims for the current change. Each claim is covered fail-closed ' +
    'by an implementation validation attempt (by checkId) at the current revision; cite an approved ' +
    'authority (ticket/plan/architecture) to classify a claim as a governing fact, otherwise it is ' +
    'a NOT_VERIFIED assumption. Available in IMPL_VALIDATION and IMPL_REVIEW; advisory - it records ' +
    'evidence-bound claims and never alters review acceptance.',
  args: {
    claims: z
      .array(
        z.object({
          statement: z.string().min(1).describe('The behavioral claim being asserted.'),
          checkId: z
            .string()
            .min(1)
            .describe('Active check whose implementation attempt is the claim evidence.'),
          critical: z
            .boolean()
            .describe(
              'Whether the claim is critical. Required and explicit: a critical claim can block ' +
                'the final approval, so it must never be assumed. A critical claim additionally ' +
                'requires a distinct counterexampleCheckId.',
            ),
          counterexampleCheckId: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Optional distinct check whose FAILURE would contradict this claim (adversarial falsification); required for critical claims.',
            ),
          authority: z
            .enum(['ticket', 'plan', 'architecture'])
            .optional()
            .describe(
              'Approved GOVERNING source for this claim (ticket/plan/architecture). Only a ' +
                'resolved authority classifies the claim as `fact`; without one it is a ' +
                'NOT_VERIFIED assumption. Validation evidence is never a governing authority.',
            ),
          structuralSurface: z
            .enum([SURFACE_COMMAND_REGISTRATION, SURFACE_CONFIG_DEFAULTS])
            .optional()
            .describe(
              'Optional cross-artifact consistency surface whose assertion also covers this ' +
                'claim. Becomes required positive evidence and is bound to the surface digest, ' +
                'so the claim goes STALE when that surface changes.',
            ),
          mutationProfile: z
            .enum(MUTATION_PROFILE_ENUM)
            .optional()
            .describe(
              'Optional opt-in semantic mutation profile. Becomes required positive evidence: ' +
                'surviving mutants make the claim UNPROVEN, and a profile with no recorded ' +
                'mutation report is NOT_VERIFIED rather than a pass.',
            ),
          counterexampleRequirement: CounterexampleRequirement.optional().describe(
            'Optional counterexample binding requirement. mode=check: legacy check-level counterexample. ' +
              'mode=assertion: targeted counterexample bound to a concrete assertion (junit:/vitest:/jest:/go: prefix).',
          ),
        }),
      )
      .min(1)
      .describe(
        'Claims to declare, each covered by an implementation check at the current revision.',
      ),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
        if (!DECLARE_CONTRACT_PHASES.has(state.phase)) {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/declare-contract',
            phase: state.phase,
          });
        }
        const implementation = state.implementation;
        if (!implementation) return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');

        // #762: reject a claim set that could never become PROVEN before any
        // evidence is resolved or persisted.
        const contractViolation = validateDeclaredClaimContract(
          args.claims as readonly RawClaim[],
          state,
        );
        if (contractViolation) return contractViolation;

        const mergeViolation = validateMergedClaimIds(args.claims as readonly RawClaim[], state);
        if (mergeViolation) return mergeViolation;

        const capabilityGate = validateAssertionCapabilityGate(
          args.claims as readonly RawClaim[],
          state,
        );
        if (capabilityGate) return capabilityGate;

        const worktree = getWorktree(context);
        const verdicts = await resolveVerifiedMutationVerdicts(worktree, state.mutationAttempts);
        const built = buildDeclaredClaims(
          state,
          args.claims as readonly RawClaim[],
          implementation.digest,
          verdicts,
        );
        if ('unresolvedCheckId' in built) {
          return formatBlocked('PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED', {
            checkId: built.unresolvedCheckId,
          });
        }
        if ('unresolvedProfileId' in built) {
          return formatBlocked('PROOFGRAPH_MUTATION_ATTEMPT_UNRESOLVED', {
            profileId: built.unresolvedProfileId,
          });
        }

        // Preserve certificate-bound claims exactly as materialized. Manual claims
        // have no approval binding and therefore remain advisory at the final gate.
        const proofContract = {
          version: 'contract.v1' as const,
          claims: [...(state.proofContract?.claims ?? []), ...built.claims],
        };
        const stateWithContract = { ...state, proofContract };
        const proofGraph = await refreshProofGraph(stateWithContract, ctx.now());
        const nextState = { ...state, proofContract, proofGraph };
        await writeStateWithArtifacts(sessDir, nextState);
        return appendNextAction(
          JSON.stringify({
            phase: nextState.phase,
            status: 'ProofGraph claims added; projection recorded.',
            proofGraph,
          }),
          nextState,
        );
      });
    } catch (error) {
      return formatError(error);
    }
  },
};
