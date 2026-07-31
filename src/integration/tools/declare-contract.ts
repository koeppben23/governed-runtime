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
 * Advisory: it records evidence-bound claims and never alters review acceptance,
 * which remains owned by ReviewFindings, obligations, attestations, and policy.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';

import type { Phase, SessionState } from '../../state/schema.js';
import type { DeclaredClaim } from '../../state/proofgraph.js';
import type { ClaimAuthorityRef } from '../../state/proofgraph-refs.js';
import { deriveProofGraph } from '../../audit/proofgraph/derive.js';
import { bindExecutedTestEvidence } from '../../audit/proofgraph/executed-test-binder.js';
import { bindCounterexamples } from '../../audit/proofgraph/counterexample-binder.js';
import type { ToolDefinition } from './helpers.js';
import {
  appendNextAction,
  formatBlocked,
  formatError,
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
  critical?: boolean;
  counterexampleCheckId?: string;
  authority?: AuthoritySource;
};

/**
 * Resolve raw claim inputs into DeclaredClaims. Evidence (the covering check and
 * optional counterexample check) is bound fail-closed to implementation attempts
 * at `digest`. Governing provenance is resolved SEPARATELY from the cited
 * approved authority: a claim is `fact` only when an approved authority resolves;
 * otherwise it is a `hypothesis` with `null` provenance (surfaced NOT_VERIFIED).
 * Returns the built claims, or the first checkId that could not resolve.
 */
function buildDeclaredClaims(
  state: SessionState,
  rawClaims: readonly RawClaim[],
  digest: string,
): { readonly claims: DeclaredClaim[] } | { readonly unresolvedCheckId: string } {
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
    const critical = rc.critical ?? true;
    claims.push({
      claimId: claimIdFor(rc.statement),
      statement: rc.statement,
      // No auto-`fact`: classification follows the resolved governing authority.
      signalClass: isFact ? 'fact' : 'hypothesis',
      critical,
      provenance,
      evidenceRefs: [evidenceRef],
      counterexampleRefs,
      // A critical fact claim must survive an executed counterexample before it
      // may be PROVEN; a missing/unresolved counterexample keeps it NOT_VERIFIED.
      requiredEvidence: {
        positive: ['executed_test' as const],
        adversarial: critical && isFact ? ['counterexample' as const] : [],
      },
    });
  }
  return { claims };
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
            .optional()
            .describe('Whether the claim is critical (default true).'),
          counterexampleCheckId: z
            .string()
            .min(1)
            .optional()
            .describe(
              'Optional check whose FAILURE would contradict this claim (adversarial falsification).',
            ),
          authority: z
            .enum(['ticket', 'plan', 'architecture'])
            .optional()
            .describe(
              'Approved GOVERNING source for this claim (ticket/plan/architecture). Only a ' +
                'resolved authority classifies the claim as `fact`; without one it is a ' +
                'NOT_VERIFIED assumption. Validation evidence is never a governing authority.',
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

        const built = buildDeclaredClaims(
          state,
          args.claims as readonly RawClaim[],
          implementation.digest,
        );
        if ('unresolvedCheckId' in built) {
          return formatBlocked('PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED', {
            checkId: built.unresolvedCheckId,
          });
        }

        const proofContract = { version: 'contract.v1' as const, claims: built.claims };
        const now = ctx.now();
        const stateWithContract = { ...state, proofContract };
        const providerResults = bindExecutedTestEvidence(stateWithContract, now);
        const counterexamples = bindCounterexamples(stateWithContract, now);
        const proofGraph = deriveProofGraph(
          stateWithContract,
          providerResults,
          counterexamples,
          now,
        );
        const nextState = { ...state, proofContract, proofGraph };
        await writeStateWithArtifacts(sessDir, nextState);
        return appendNextAction(
          JSON.stringify({
            phase: nextState.phase,
            status: 'ProofGraph contract declared; projection recorded.',
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
