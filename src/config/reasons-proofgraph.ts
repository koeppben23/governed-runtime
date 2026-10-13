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

/** Recovery for an authority change after plan approval; never a phase backedge. */
const CERTIFIED_PLAN_RECOVERY: readonly string[] = [
  'After plan approval, /plan is not admissible in IMPLEMENTATION or EVIDENCE_REVIEW; at EVIDENCE_REVIEW, /request-changes returns to IMPLEMENTATION, not PLAN',
  'Preserve the old session id, plan/certificate digests, detected triggers and code changes; on explicit user instruction run /abort to retain the terminal audit trail',
  'Operator action: prepare a separate worktree at the original trusted pre-change base, then start a new host session with a different host-session id; run /hydrate there and verify a distinct FlowGuard session id and READY phase',
  'Re-running /hydrate in the old host session only reloads it, including after /abort; existing unchanged dirty files in a new session are baseline, not new implementation evidence',
  'In the new session run /ticket, then /plan with complete corrected claims and coversRiskTriggers for every applicable specific trigger; complete independent review and obtain a new approval certificate under the active policy',
  'Only in the new authorized IMPLEMENTATION step, reapply the preserved changes through the regular governed host-mutation contract, then run /implement to record their complete scope and a fresh risk assessment; an out-of-workflow git apply is not retroactively authorized',
  'Run fresh positive and adversarial checks and complete the required implementation review before evidence approval; never copy old certificates, validation attempts or PROVEN projections, even for identical code bytes',
  'If a new host binding or trustworthy pre-change base is unavailable, stop and report that recovery prerequisite as blocked; do not edit session authority files or reset the existing session',
];

/** Reason codes for recording and consuming ProofGraph mutation evidence. */
export const PROOFGRAPH_REASONS: readonly BlockedReason[] = [
  {
    code: 'PROOFGRAPH_ASSERTION_IDENTITY_AMBIGUOUS',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimId}' references assertion evidence with duplicate provider-scoped identities; no first or last result is authoritative.",
    recoverySteps: [
      'Inspect the producing reports and reporter configuration; emit each canonical providerId/localId exactly once per assertion-capable attempt',
      'Preserve historical observations; never deduplicate, reorder or edit persisted evidence to make it pass',
      'At EVIDENCE_REVIEW request changes to return to IMPLEMENTATION; repair through governed mutation, record the new implementation and execute fresh checks and required review',
      'Same-revision positive failures are not silently superseded; follow the existing implementation repair policy, and use new-session authority recovery if approved declarations must change',
    ],
  },
  {
    code: 'PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimRef}' cannot be declared: {field} — {detail}. A claim that cannot become PROVEN would block the final approval permanently, so it is rejected at declaration time.",
    recoverySteps: [
      'Correct the named field for that claim and resubmit the complete declaration set',
      'A critical claim needs an assertion- or aggregate-capable counterexample check with a different check identity and its own validation attempt',
      'Reference only checks that are active in this session, and registered surfaces/profiles',
      'For /plan correct and resubmit in TICKET or PLAN; for advisory /declare-contract correct and resubmit in IMPL_VALIDATION or IMPL_REVIEW',
    ],
  },

  {
    code: 'PROOFGRAPH_CLAIM_UNSATISFIABLE',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimRef}' cannot be declared: {field} — {detail}. This claim can never become PROVEN regardless of fresh evidence.",
    recoverySteps: [
      'Correct the structural incompatibility identified in the claim detail',
      'For a suite claim, remove or narrow the claim, or select a provider with explicit aggregate full-check completeness authority',
      'For an assertion counterexample claim, ensure the selected provider, capability, and localId are valid',
      'In TICKET or PLAN resubmit /plan with complete corrected declarations; at PLAN_REVIEW request changes to return to PLAN first',
      'For advisory /declare-contract in IMPL_VALIDATION or IMPL_REVIEW, correct and resubmit the manual declaration; it cannot repair plan-certified coverage',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },

  {
    code: 'PROOFGRAPH_CLAIM_NOT_DECLARED',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimRef}' was not admitted to the ProofGraph: {field} — {detail}. {consequence}",
    recoverySteps: [
      'In TICKET or PLAN, correct the declarations and resubmit /plan; for a pending reviewer changes_requested verdict, resubmit the revision call with corrected claims',
      'At PLAN_REVIEW, request changes (`changes_requested`) to return to PLAN, then resubmit /plan with corrected declarations or explicit claims: [] to withdraw them',
      'Use explicit claims: [] to withdraw declarations when no ProofGraph authority is required',
      'Narrow the claim to a concrete behavior with assertion-capable evidence, or select a provider with explicit aggregate full-check completeness authority',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },

  {
    code: 'PROOFGRAPH_CERTIFICATE_INVALID',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because the plan approval certificate is missing, stale, or does not bind the current plan.',
    recoverySteps: [
      'Do not approve evidence until the certificate binds the current plan record and declarations',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },
  {
    code: 'PROOFGRAPH_COUNTEREXAMPLE_OBSERVED',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimId}' is contradicted by fresh adversarial evidence from its bound counterexample check.",
    recoverySteps: [
      'Inspect the failing assertion produced by the counterexample check',
      'At EVIDENCE_REVIEW request changes to return to IMPLEMENTATION; correct the implementation under the unchanged approved claim, record it with /implement and re-run the required checks and review',
      'If the claim itself must change, follow the new-session authority recovery below',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },

  {
    code: 'PROOFGRAPH_CRITICAL_FACTS_UNPROVEN',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because critical fact claim(s) are not PROVEN: {claimIds}.',
    recoverySteps: [
      'At EVIDENCE_REVIEW request changes to return to IMPLEMENTATION; record the repaired implementation with /implement, execute the required checks and complete review for every listed critical fact claim',
      'If the evidence route is structurally incompatible, follow the new-session authority recovery below; re-running checks cannot repair its binding',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },

  {
    code: 'PROOFGRAPH_CRITICAL_FACT_REQUIRED',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because {triggers} requires at least one critical, certificate-authorized fact claim.',
    recoverySteps: [
      'The corrected plan needs a critical claim with distinct expected and counterexample checks; a manual /declare-contract claim cannot supply plan-certificate authority',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },

  {
    code: 'PROOFGRAPH_RISK_TRIGGER_UNCOVERED',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because no certificate-authorized critical claim covers the detected risk trigger(s): {triggers}.',
    recoverySteps: [
      'The corrected plan needs coversRiskTriggers on critical claims for every detected trigger; never widen the already-approved declaration set in place',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },

  {
    code: 'EXPORT_READY_APPROVAL_UNVERIFIED',
    category: 'state',
    messageTemplate:
      'The EXPORT_READY approval was not persisted because the persisted evidence does not clear the canonical evidence-approval preflight.',
    recoverySteps: [
      'Recompute the evidence for the current implementation revision and retry the evidence approval',
      'Apply the approval through the protected transition application, never a direct state write',
      'Do not retry a persisted approval that no longer clears the preflight; fix the evidence first',
    ],
  },

  {
    code: 'PROOFGRAPH_EVALUATION_UNAVAILABLE',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because certificate-authorized critical plan claim(s) have no unique, correctly bound source and usable ProofGraph evaluation: {claimIds}.',
    recoverySteps: [
      'At EVIDENCE_REVIEW request changes to return to IMPLEMENTATION; run /implement, fresh /check executions and the required review to rematerialize the unchanged approved claims through the regular product path',
      'Do not approve until every certificate-authorized critical plan claim is present and evaluated',
    ],
  },

  {
    code: 'PROOFGRAPH_RISK_ASSESSMENT_STALE',
    category: 'precondition',
    messageTemplate:
      'Evidence approval is blocked because the implementation risk assessment is missing, stale, or predates trigger classification.',
    recoverySteps: [
      'At EVIDENCE_REVIEW request changes to return to IMPLEMENTATION; run /implement to record a fresh implementation assessment, then execute /check and the required review',
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
    code: 'PROOFGRAPH_ASSERTION_EVIDENCE_MISSING',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimId}' requires positive evidence, but no provider result is bound to the required check '{checkId}' (or the binding is not fresh).",
    recoverySteps: [
      'Run the required verification check for the claim and record its result',
      'Verify the evidence binds the current implementation revision and the expected check identifier',
      'Rerun the check so a fresh, matching report is recorded',
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
    code: 'PROOFGRAPH_PROVIDER_EXECUTION_ERROR',
    category: 'precondition',
    messageTemplate:
      "Verification check '{checkId}' for claim '{claimId}' could not execute, so its provider produced no result to bind as evidence.",
    recoverySteps: [
      'Run the check locally to inspect the provider execution error',
      'Fix the check command or execution environment so the provider can run',
      'Rerun the check and record a fresh, matching report',
    ],
  },

  {
    code: 'PROOFGRAPH_AGGREGATE_CHECK_MISMATCH',
    category: 'precondition',
    messageTemplate: "Aggregate evidence was recorded by a different check than '{checkId}'.",
    recoverySteps: ['Run the aggregate counterexample check named by the claim'],
  },
  {
    code: 'PROOFGRAPH_AGGREGATE_SCOPE_UNATTESTED',
    category: 'precondition',
    messageTemplate:
      "Aggregate evidence for check '{checkId}' is not explicitly attested as a complete suite run.",
    recoverySteps: [
      'Run the complete declared suite without test filters and record its full-check attestation',
    ],
  },
  {
    code: 'PROOFGRAPH_AGGREGATE_EXTRACTION_MISSING',
    category: 'precondition',
    messageTemplate: "Aggregate evidence for check '{checkId}' has no extractable result report.",
    recoverySteps: ['Re-run the check with its registered aggregate report configuration'],
  },
  {
    code: 'PROOFGRAPH_AGGREGATE_CAPABILITY_MISSING',
    category: 'precondition',
    messageTemplate:
      "Evidence for check '{checkId}' is not registered for aggregate suite binding.",
    recoverySteps: ['Use a verification profile with registered aggregate report capability'],
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
  {
    code: 'PROOFGRAPH_EVIDENCE_ROLE_COLLISION',
    category: 'precondition',
    messageTemplate:
      "Claim '{claimId}' cannot be proven because the same check or validation attempt is bound as both its positive evidence and its counterexample; both check identities and executions must be distinct.",
    recoverySteps: [
      'If the approved check identities are already distinct, use the regular implementation repair/recheck loop to record independent validation attempts',
      'If the declared check identities collide, a new approved authority is required; executing the same check twice cannot repair the declaration',
      ...CERTIFIED_PLAN_RECOVERY,
    ],
  },
];
