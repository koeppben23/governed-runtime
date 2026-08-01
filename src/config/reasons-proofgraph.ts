/**
 * @module config/reasons-proofgraph
 * @description ProofGraph mutation-evidence reason codes.
 *
 * Split out of `reasons-precondition.ts` so the precondition catalogue stays
 * within the file-size budget and ProofGraph mutation failures live together.
 * These are all fail-closed preconditions: mutation evidence must be recorded,
 * bound to an implementation revision, and re-verifiable before a claim may rely
 * on it.
 *
 * @version v1
 */

import type { BlockedReason } from './reasons-types.js';

/** Reason codes for recording and consuming ProofGraph mutation evidence. */
export const PROOFGRAPH_REASONS: readonly BlockedReason[] = [
  {
    code: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because critical fact claim(s) are not PROVEN: {claimIds}.',
    recoverySteps: [
      'Record fresh evidence that proves every listed critical fact claim',
      'Return to EVIDENCE_REVIEW and approve after the persisted ProofGraph is PROVEN',
    ],
  },

  {
    code: 'PROOFGRAPH_MUTATION_PHASE_INELIGIBLE',
    category: 'precondition',
    messageTemplate:
      "Mutation evidence cannot be recorded in phase '{phase}'; an implementation must exist and be under validation or review.",
    recoverySteps: [
      'Reach IMPL_VALIDATION or IMPL_REVIEW before recording mutation evidence',
      'Record the mutation run against the implementation it was executed on',
    ],
  },

  {
    code: 'PROOFGRAPH_MUTATION_NO_IMPLEMENTATION',
    category: 'precondition',
    messageTemplate:
      'No implementation evidence exists, so mutation evidence cannot be bound to an implementation revision.',
    recoverySteps: [
      'Run /implement (flowguard_implement) so an implementation digest exists',
      'Re-run the mutation command and record the evidence afterwards',
    ],
  },

  {
    code: 'PROOFGRAPH_MUTATION_REPORT_MISSING',
    category: 'precondition',
    messageTemplate: "No mutation report was found at '{reportPath}'.",
    recoverySteps: [
      'Run the mutation command (for example npm run mutation) so a report is produced',
      'Pass the repository-relative reportPath the mutation tool actually wrote',
    ],
  },

  {
    code: 'PROOFGRAPH_MUTATION_REPORT_INVALID',
    category: 'precondition',
    messageTemplate: "The mutation report at '{reportPath}' could not be parsed: {message}",
    recoverySteps: [
      'Re-run the mutation command so a complete report is written',
      'Verify the report uses the mutation-testing-elements JSON schema',
    ],
  },

  {
    code: 'PROOFGRAPH_MUTATION_ATTEMPT_UNRESOLVED',
    category: 'precondition',
    messageTemplate:
      "No verified mutation attempt covers profile '{profileId}' at the current implementation revision; a claim cannot rely on mutation evidence that does not exist.",
    recoverySteps: [
      'Run the mutation command and record it with flowguard_record_mutation_evidence',
      'Record the evidence at the current implementation digest, then declare the claim',
    ],
  },
];
