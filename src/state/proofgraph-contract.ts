/**
 * @module proofgraph-contract
 * @description Thin, in-session ProofGraph contract declaration (contract.v1).
 *
 * A declaration-only mechanism: it names the claims a change asserts and points
 * each claim at an approved-source reference (ticket/plan/ADR/implementation).
 * It is deliberately NOT a runtime authority:
 *
 * - The evaluator resolves each claim's provenance against evidence that is
 *   actually present; an unresolved reference is surfaced as `NOT_VERIFIED`.
 * - Existing review, decision, and validation authorities remain the sole
 *   acceptance authorities. A contract never approves or gates anything.
 *
 * Claims are stored as the evaluator's `DeclaredClaim` shape so the contract and
 * the evaluator share one vocabulary instead of duplicating it.
 *
 * @version v1
 */

import { z } from 'zod';
import { DeclaredClaim } from './proofgraph.js';

/** Persisted contract declaration schema version. */
export const PROOFGRAPH_CONTRACT_VERSION = 'contract.v1' as const;

/** A change's declared claims plus their approved-source references. */
export const ProofContract = z
  .object({
    version: z.literal(PROOFGRAPH_CONTRACT_VERSION),
    claims: z.array(DeclaredClaim),
  })
  .readonly();
export type ProofContract = z.infer<typeof ProofContract>;

/** Cause-specific coverage gaps recorded when approved declarations materialize. */
export const ProofContractCoverage = z
  .object({
    claimId: z.string().uuid().optional(),
    cause: z.enum([
      'missing_declarations',
      'missing_certificate',
      'invalid_certificate',
      'missing_implementation',
      'missing_expected_check',
      'unverified_mutation_profile',
    ]),
  })
  .readonly();
export type ProofContractCoverage = z.infer<typeof ProofContractCoverage>;
