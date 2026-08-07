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
    code: 'PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimRef}' cannot be declared: {field} — {detail}. A claim that cannot become PROVEN would block the final approval permanently, so it is rejected at declaration time.",
    recoverySteps: [
      'Correct the named field for that claim and resubmit the complete declaration set',
      'A critical claim needs a counterexample check that would falsify it',
      'Reference only checks that are active in this session, and registered surfaces/profiles',
    ],
  },

  {
    code: 'PROOFGRAPH_CLAIM_UNSATISFIABLE',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimRef}' cannot be declared: {field} — {detail}. This claim can never become PROVEN regardless of fresh evidence.",
    recoverySteps: [
      'Ensure the counterexample check has assertionCapability=structured',
      'Verify the assertion provider matches the verification candidate',
      'Confirm the assertion localId is valid for the provider codec',
      'Re-submit the plan with corrected claim declarations',
    ],
  },

  {
    code: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because critical fact claim(s) are not PROVEN: {claimIds}.',
    recoverySteps: [
      'Record fresh evidence that proves every listed critical fact claim',
      'If the declared evidence route is no longer satisfiable, return to plan revision; re-running checks cannot repair a structurally incompatible claim binding',
      'Return to EVIDENCE_REVIEW and approve after the persisted ProofGraph is PROVEN',
    ],
  },

  {
    code: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because {triggers} requires at least one critical, certificate-authorized fact claim.',
    recoverySteps: [
      'Request changes to return to implementation, then add a critical plan claim with expected and counterexample checks',
      'Obtain plan approval so the declaration receives its certificate binding',
      'Record fresh evidence that proves the critical fact claim before requesting approval again',
    ],
  },

  {
    code: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because certificate-authorized critical plan claim(s) have no persisted ProofGraph evaluation: {claimIds}.',
    recoverySteps: [
      'Request changes to return to implementation and restore the missing ProofGraph projection',
      'Do not approve until every certificate-authorized critical plan claim is present and evaluated',
    ],
  },

  {
    code: 'PROOFGRAPH_RISK_ASSESSMENT_STALE',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because the implementation risk assessment is missing, stale, or predates trigger classification.',
    recoverySteps: [
      'Request changes to return to implementation and record a fresh implementation assessment',
      'Do not approve until the assessment is bound to the current implementation digest and includes risk triggers',
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

  {
    code: 'UNSUPPORTED_ASSERTION_CAPABILITY',
    category: 'precondition',
    messageTemplate:
      "Verification check '{checkId}' does not support structured assertion evidence for counterexample binding.",
    recoverySteps: [
      'Use a verification command that produces structured test reports (e.g. Maven Surefire, Gradle, Vitest, Jest)',
      'Ensure the project is configured with a recognized test framework',
    ],
  },

  {
    code: 'PROOFGRAPH_ASSERTION_BINDING_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      "Assertion-level claim '{claimId}' requires assertion-binding-capable evidence, but the report for check '{checkId}' only provides check-level evidence (bindingCapability=check_only).",
    recoverySteps: [
      'Use a verification command that produces structured test reports with assertion-level identity',
      'Rerun the verification check with an assertion-binding-capable reporter configuration',
    ],
  },

  {
    code: 'PROOFGRAPH_ASSERTION_IDENTITY_MISMATCH',
    category: 'precondition',
    messageTemplate:
      "Assertion '{required}' required by claim '{claimId}' was not found in the report for check '{checkId}'. Found: {found}.",
    recoverySteps: [
      'Verify that the required test is included in the verification check output',
      'Check that the test name matches the expected assertion identity exactly',
      'Rerun the verification check and confirm the assertion appears in the report',
    ],
  },

  {
    code: 'PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimId}' requires assertions from provider '{required}', but the report for check '{checkId}' was produced by '{actual}'.",
    recoverySteps: [
      'Ensure the verification check uses the correct test framework',
      'A JUnit assertion cannot be proven by Vitest output or vice versa',
    ],
  },

  {
    code: 'PROOFGRAPH_EVIDENCE_STALE',
    category: 'precondition',
    messageTemplate:
      "Evidence for claim '{claimId}' is bound to a non-current revision and cannot prove the claim for the current implementation.",
    recoverySteps: [
      'Re-run the verification checks against the current implementation revision',
      'Stale evidence must be refreshed before it can satisfy a claim',
    ],
  },
];
