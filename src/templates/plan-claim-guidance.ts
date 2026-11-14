/** Presentation-only planning guidance; executable parity is tested against claim admission. */
export const PLAN_CLAIM_REPAIR_INSTRUCTION =
  'Read each rejected declaration field in claimSubmissionDiagnostics, correct the complete claim set and resubmit the complete plan in the current planning step. ' +
  'A rejected submission created no plan version or reviewer attempt; do not start a new session for this rejection. ' +
  'Inspect the active verificationCandidates: build and test are different check identities even if their commands overlap; an assertion requirement must name the exact provider and assertion that observes the claim. ' +
  'Admission is not proof: do not claim executed verification or a successful falsification from an accepted declaration. ' +
  'Do not automatically remove or downgrade critical claims, invent capabilities, or retry the unchanged invalid payload. ' +
  'If a genuinely required evidence route is unavailable, explain the precise missing capability and ask the user; claims: [] is only an explicit withdrawal when no required ProofGraph authority is lost.';

export const PLAN_CLAIM_GUIDANCE = `### Claim declarations

- Submit the complete \`claims\` with every plan submission or revision. Each claim names one falsifiable \`statement\`, its \`authoritySectionId\`, \`critical\`, \`claimScope\`, and \`expectedCheckId\`. Do NOT provide \`claimId\`: FlowGuard mints claim identity host-side.
- Keep statements no broader than the evidence observes. Internal side effects, ordering, and forbidden calls require direct observation. A passing check alone does not establish a specific behavior.
- Positive and adversarial evidence require different check identities AND different validation attempts. \`counterexampleRequirement.checkId\` MUST differ from \`expectedCheckId\` whenever a counterexample is declared, at every criticality. Running the same check twice is not independence; never invent attempt identities.
- Every critical claim requires \`counterexampleRequirement\`. For \`specific_behavior\` use \`kind: "assertion"\` with a provider-scoped \`assertion.providerId\` and \`assertion.localId\` that directly observe the claimed behavior. A noncritical specific claim still needs a claim-specific assertion, registered structural surface, or supported mutation binding.
- A counterexample is a targeted falsification, not a second green run: it must exercise a concrete violating variant and show the bound check detects it. For a checkable invariant, the build/aggregate check is acceptable when the designed faulty variant is provably rejected; different check identities and separate attempts remain required, but different assertion identities are not.
- Before submission, describe each critical claim's positive observable, concrete violating variant, bound check's expected failure, and separate execution route in the plan's Verification section. A faulty variant need not already exist in the frozen suite; plan how to exercise it through an admissible evidence route. Do not execute it during planning or describe a planned execution as completed.
- Distinguish incidental regression-suite coverage from claim-specific proof. If required critical behavior has no admissible evidence route, report the precise missing capability and recovery; do not remove or downgrade the required claim to obtain acceptance. Mark incidental coverage limits as \`NOT_VERIFIED\` with recovery, never as a substitute for mandatory evidence.
- Avoid unbound promises such as "no new warnings": name the diagnostic source, comparison baseline, and observable pass/fail condition, or state the verification limit and recovery. A successful build alone does not prove warning absence.
- When a review returns \`changes_requested\`, address every blocking finding from that review. Map each finding to the changed plan section or claim and state what changed; do not submit a revision that fixes only the first finding.
- When the review response reports that the iteration budget is exhausted (or the gate requires a governance override), stop. Do not submit another silent revision. Tell the user to run \`/request-changes\` for a fresh review cycle, or \`/override-approve <Begründung>\` to accept the reviewed plan despite the open findings.
- For \`suite\` use \`kind: "aggregate_check"\`: the positive candidate needs structured full-suite capability, and the adversarial candidate needs registered aggregate capability AND \`fullCheckScopeAttestation: "full_check"\`. Structured assertion reports alone are not aggregate coverage.
- Select only active checks and current \`verificationCandidates\` capable of producing the required evidence. Do not invent providers, assertion identities, aggregate capabilities, or proving mutation providers. If no admissible evidence route exists, report the blocker instead of submitting an unprovable claim.
- On declaration rejection: ${PLAN_CLAIM_REPAIR_INSTRUCTION}
- Declare \`coversRiskTriggers\` on critical claims for every known applicable specific risk: \`state_integrity\`, \`audit_authority\`, \`identity_boundary\`, \`approval_authority\`, \`policy_authority\`, \`migration\`, \`distribution_integrity\`, \`command_contract\`. Coverage must match the behavior actually asserted, never be inferred from prose or added indiscriminately. \`ceremony_only\` is not declarable coverage.
- \`targetPaths\` are review-scoping forecasts, not the binding implementation risk assessment. Declare repository-relative file paths separately from Discovery classification paths. Approval compares their canonical identities with baseline/current dirt; unknown scope with dirt or unavailable baseline capture blocks. A revision replaces explicitly supplied targets, or retains prior targets when omitted. Actual implementation changes can discover additional triggers that approved claims did not cover.
- Claims are pre-evidence declarations, not proof. The certificate binds the exact declaration set. Never widen an approved declaration in place. At EVIDENCE_REVIEW, request changes returns to IMPLEMENTATION, not PLAN. For a required authority change follow the canonical new-session recovery in the returned reason; re-running checks cannot repair missing approved coverage.

Example declaration, ONLY if build/test are active and test has a matching JUnit assertion-capable candidate. Replace the statement, section and assertion with real plan/repository evidence; do not copy this illustrative identity blindly:

\`\`\`json
{
  "statement": "Invalid session state is rejected before persistence.",
  "critical": true,
  "claimScope": "specific_behavior",
  "authoritySectionId": "implementation-step-1",
  "expectedCheckId": "build",
  "counterexampleRequirement": {
    "kind": "assertion",
    "checkId": "test",
    "assertion": { "providerId": "junit", "localId": "com.example.SessionTest#rejectInvalidState" }
  },
  "coversRiskTriggers": ["state_integrity"]
}
\`\`\`
`;
