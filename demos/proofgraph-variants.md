# ProofGraph Variants

These variants are separate from `java-task-manager/DEMO_SCRIPT.md`. The Java
task-manager happy path demonstrates only certificate-authorized plan claims.
Run the executable fixtures with:

```bash
./demos/run-proofgraph-variants.sh
```

## Manual Advisory Merge

The fixture drives a governed session to `IMPL_REVIEW`, then declares an
additional manual claim. It verifies that manual claims are additive and cannot
replace the approved plan contract.

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

The fixture creates a disposable FlowGuard workspace with distinct active
`build` and `test` checks. It drives the real tools through plan approval,
implementation, both validations, and implementation review. Its critical plan
claim requires the `proofgraph-evaluator` mutation profile, but deliberately
does not record mutation evidence with `flowguard_record_mutation_evidence`.

The claim reaches `EVIDENCE_REVIEW` but remains not PROVEN because its required
fault-injection provider is not verified. The final approval must fail with
`PROOFGRAPH_CRITICAL_FACTS_UNPROVEN`.

Do not simulate this result by editing session state. A failed or missing active
validation check demonstrates the earlier validation gate instead and cannot
reach the final evidence approval.
