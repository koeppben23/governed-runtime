# ProofGraph Variants

These variants are separate from `java-task-manager/DEMO_SCRIPT.md`. The Java
task-manager happy path demonstrates only certificate-authorized plan claims.

## Manual Advisory Merge

Run this after a session has reached `IMPL_REVIEW` with implementation evidence.
It demonstrates that manual claims are additive and cannot replace the approved
plan contract.

```text
flowguard_declare_contract({
  claims: [{
    statement: "The implementation has an additional documented property.",
    checkId: "test",
    critical: false,
    authority: "plan"
  }]
})
flowguard_status({ proofGraph: true })
```

Expected result:

- Existing certificate-bound plan facts remain unchanged.
- The new manual claim has plan provenance but no approval binding.
- The manual claim is advisory and never gate-eligible.
- `proofContractCoverage` is unchanged.

## Final Gate Block

Use a disposable checkout of FlowGuard itself. This variant needs the
`proofgraph-evaluator` mutation profile and therefore is not part of the Java
task-manager fixture.

1. Record a normal ticket and plan for a small, reviewable change under
   `src/audit/proofgraph/evaluate.ts`.
2. Declare one critical plan claim with distinct active checks and
   `mutationProfile: "proofgraph-evaluator"`.
3. Approve the plan, implement the change, and pass both validation checks.
4. Deliberately do not record mutation evidence with
   `flowguard_record_mutation_evidence`.
5. Complete the independent implementation review through the normal host-task
   path, then request final approval.

The claim reaches `EVIDENCE_REVIEW` but remains not PROVEN because its required
fault-injection provider is not verified. The final approval must fail with
`PROOFGRAPH_CRITICAL_FACTS_UNPROVEN`.

Do not simulate this result by editing session state. A failed or missing active
validation check demonstrates the earlier validation gate instead and cannot
reach the final evidence approval.
