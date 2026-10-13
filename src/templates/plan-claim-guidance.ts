/** Presentation-only planning guidance; executable parity is tested against claim admission. */
export const PLAN_CLAIM_GUIDANCE = `### Claim declarations

- Submit the complete \`claims\` with every plan submission or revision. Each claim names one falsifiable \`statement\`, its \`authoritySectionId\`, \`critical\`, \`claimScope\`, and \`expectedCheckId\`. Do NOT provide \`claimId\`: FlowGuard mints claim identity host-side.
- Keep statements no broader than the evidence observes. Internal side effects, ordering, and forbidden calls require direct observation. A passing check alone does not establish a specific behavior.
- Positive and adversarial evidence require different check identities AND different validation attempts. \`counterexampleRequirement.checkId\` MUST differ from \`expectedCheckId\` whenever a counterexample is declared, at every criticality. Running the same check twice is not independence; never invent attempt identities.
- Every critical claim requires \`counterexampleRequirement\`. For \`specific_behavior\` use \`kind: "assertion"\` with a provider-scoped \`assertion.providerId\` and \`assertion.localId\` that directly observe the claimed behavior. A noncritical specific claim still needs a claim-specific assertion, registered structural surface, or supported mutation binding.
- For \`suite\` use \`kind: "aggregate_check"\`: the positive candidate needs structured full-suite capability, and the adversarial candidate needs registered aggregate capability AND \`fullCheckScopeAttestation: "full_check"\`. Structured assertion reports alone are not aggregate coverage.
- Select only active checks and current \`verificationCandidates\` capable of producing the required evidence. Do not invent providers, assertion identities, aggregate capabilities, or proving mutation providers. If no admissible evidence route exists, report the blocker instead of submitting an unprovable claim.
- Declare \`coversRiskTriggers\` on critical claims for every known applicable specific risk: \`state_integrity\`, \`audit_authority\`, \`identity_boundary\`, \`approval_authority\`, \`policy_authority\`, \`migration\`, \`distribution_integrity\`, \`command_contract\`. Coverage must match the behavior actually asserted, never be inferred from prose or added indiscriminately. \`ceremony_only\` is not declarable coverage.
- \`targetPaths\` are advisory and can be partial or unknown. The binding risk assessment comes from actual implementation changes; it can discover additional triggers that the approved plan did not cover.
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
