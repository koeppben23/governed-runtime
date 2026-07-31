# FlowGuard ProofGraph

The ProofGraph makes a change's critical claims traceable from an approved
source through executed, revision-bound evidence to an explicit verification
state. It improves reviewability; it does **not** claim correctness.

## Proof-status semantics

Each declared claim is evaluated to exactly one state. The evaluator is
deterministic and applies this precedence (first match wins):

| State          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `NOT_VERIFIED` | Provenance is missing, or a required provider was unavailable.          |
| `CONTRADICTED` | An executed counterexample falsified the claim.                         |
| `BLOCKED`      | A required provider errored (an execution problem, not a verdict).      |
| `UNPROVEN`     | Declared with provenance, but no passing evidence (or a failing check). |
| `PROVEN`       | Fresh, revision-bound passing evidence (or a passing structural check). |
| `STALE`        | The only passing revision-bound evidence is bound to an old revision.   |

Evidence is **digest-bound**: a passing provider result proves only while its
binding still matches the current revision/surface. `executed_test` and
`fault_injection` results bind to the implementation digest; `structural_assertion`
and `schema_compare` results bind to a canonical digest over their explicit input
surface (`surface_set`). When the bound implementation or surface changes, the
prior pass becomes `STALE` and can no longer satisfy a gate.

An **executed** provider result (`pass`/`fail`/`error`) is schema-required — not
just documented — to carry reproducible metadata: exactly one of a `command` or
`assertion` input, a `source` (location + stable id), a digest `binding`, and a
`resultDigest`. `ProofProviderResult` is a status-discriminated union, so an
`unavailable` result cannot masquerade as executed evidence and incomplete
evidence cannot be constructed or persisted.

## Residual-risk limitation (read this)

A `PROVEN` claim means only that **all policy-required, fresh, revision-bound
evidence for that claim succeeded**. It does **not** mean:

- that the change is objectively correct;
- that no undiscovered failure is possible;
- that runtime behaviour, domain rules absent from the repository, or novel
  architecture are validated.

Those remain human-review responsibilities. ProofGraph surfaces residual
uncertainty explicitly (`UNPROVEN`, `CONTRADICTED`, `STALE`, `BLOCKED`,
`NOT_VERIFIED`) precisely so that unverifiable claims never appear more certain
than they are. It is **advisory** and never alters review acceptance, which
remains owned by ReviewFindings, obligations, attestations, and validation.

## Declaring claims

`flowguard_declare_contract` (admissible in `IMPL_VALIDATION` / `IMPL_REVIEW`)
records the claims a change asserts. Each claim is bound **fail-closed** to an
implementation validation attempt at the current revision — an unsourced claim
is rejected (`PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED`), never recorded.

```
flowguard_declare_contract({
  claims: [
    {
      statement: "the change is covered by the test check",
      checkId: "test",              // evidence: a passing attempt PROVES the claim
      critical: true,               // optional (default true)
      counterexampleCheckId: "security" // optional: a check whose FAILURE contradicts the claim
    }
  ]
})
```

The tool persists the contract and the derived projection to session state and
returns the evaluated projection.

## Falsification (counterexamples)

Counterexamples are evidence-bound, never asserted. A claim's
`counterexampleCheckId` names a check whose **failure** would contradict it. The
outcome is derived from the executed validation result:

- the attempt failed → `contradicted` (the falsification succeeded → claim
  `CONTRADICTED`, which wins over any passing positive evidence);
- the attempt passed → `supported`;
- missing → `not_verified`.

A **critical `fact` claim additionally requires** a `supported` counterexample:
without an executed falsification that was attempted and did not hold, the claim
stays `NOT_VERIFIED`, never `PROVEN`. This is expressed per claim via
`requiredEvidence` (`{ positive, adversarial }`) and enforced by the evaluator; a
missing or `not_verified` counterexample is a missing required provider, not a
pass-by-fallback.

Counterexamples are themselves **revision-bound** (`boundDigest`): only a
counterexample bound to the current implementation digest may contradict the
claim or satisfy its adversarial requirement. A stale counterexample can do
neither — it cannot contradict the current revision, and it cannot stand in for
required adversarial evidence.

## Cross-artifact consistency

Two pure, structural checks detect the "green CI but registries/defaults
disagree" class and are surfaced advisorily:

- **Registration consistency** — every installed command's template body, target
  tool, and workflow command is actually registered.
- **Config-default consistency** — the config schema normalizes a minimal config,
  every required top-level key is present after defaulting, and re-parsing the
  normalized defaults is stable.

## Inspecting the ProofGraph

`flowguard_status({ proofGraph: true })` returns the advisory projection: per-claim
verification states and freshness, critical-claim rollups, and the registration
and config-default consistency reports. It is read-only and never gates.
