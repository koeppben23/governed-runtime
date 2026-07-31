/**
 * @module integration/tools/declare-contract
 * @description flowguard_declare_contract - declare evidence-bound ProofGraph claims.
 *
 * The declaration path that makes the ProofGraph non-dormant: an operator/agent
 * names the claims a change asserts, each covered by an implementation
 * validation attempt (by checkId) at the current revision. The tool resolves
 * each claim's evidence fail-closed against the canonical validation ledger -
 * an unsourced claim is rejected, never recorded - persists the contract, and
 * derives + persists the ProofGraph projection.
 *
 * Advisory: it records evidence-bound claims and never alters review acceptance,
 * which remains owned by ReviewFindings, obligations, attestations, and policy.
 *
 * @version v1
 */

import * as crypto from 'node:crypto';
import { z } from 'zod';

import type { Phase } from '../../state/schema.js';
import type { DeclaredClaim } from '../../state/proofgraph.js';
import { deriveProofGraph } from '../../audit/proofgraph/derive.js';
import { bindExecutedTestEvidence } from '../../audit/proofgraph/executed-test-binder.js';
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

export const declare_contract: ToolDefinition = {
  description:
    'Declare ProofGraph contract claims for the current change. Each claim must be covered by an ' +
    'implementation validation attempt (by checkId) at the current revision. Available in ' +
    'IMPL_VALIDATION and IMPL_REVIEW; advisory - it records evidence-bound claims and never alters ' +
    'review acceptance.',
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

        const rawClaims = args.claims as ReadonlyArray<{
          statement: string;
          checkId: string;
          critical?: boolean;
        }>;
        const claims: DeclaredClaim[] = [];
        for (const rc of rawClaims) {
          const attempt = [...state.validationAttempts]
            .reverse()
            .find(
              (a) =>
                a.scope === 'implementation' &&
                a.implementationDigest === implementation.digest &&
                a.result.checkId === rc.checkId,
            );
          if (attempt === undefined) {
            return formatBlocked('PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED', { checkId: rc.checkId });
          }
          const ref = { kind: 'validation_attempt' as const, attemptId: attempt.attemptId };
          claims.push({
            claimId: claimIdFor(rc.statement),
            statement: rc.statement,
            signalClass: 'fact',
            critical: rc.critical ?? true,
            provenance: ref,
            evidenceRefs: [ref],
            counterexampleRefs: [],
          });
        }

        const proofContract = { version: 'contract.v1' as const, claims };
        const now = ctx.now();
        const stateWithContract = { ...state, proofContract };
        const providerResults = bindExecutedTestEvidence(stateWithContract, now);
        const proofGraph = deriveProofGraph(stateWithContract, providerResults, [], now);
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
