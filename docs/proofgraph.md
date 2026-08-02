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
`resultDigest`. `ProofProviderResult` is a status-discriminated union in which
**every variant is strict**: an `unavailable` result carrying `source`,
`binding`, or `resultDigest` is _rejected_, not silently stripped, so a
semantically contradictory record cannot be persisted.

`source` describes where evidence comes from and identifies the test/check
_stably across executions_. Because the canonical validation authority records no
test-file location, executed-test evidence is modelled honestly as the logical
ledger location (`validation-check:<checkId>`, `stableId: <checkId>`) rather than
renaming a check id into a file path; the individual execution record is
referenced separately via `executionRecordId`.

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
than they are.

## What ProofGraph enforces

For **critical, plan-certified `fact` claims**, FlowGuard prevents the final
evidence approval while the declared, revision-bound positive and adversarial
evidence does not establish the claim as `PROVEN`. `PROVEN` denotes satisfied
evidence requirements, not objective absence of defects.

Enforcement is unconditional and has no policy switch. A switch would mean that
an author declares a claim critical, has it human-approved, and the system then
ignores whether it was ever proven — which contradicts the meaning of
`critical`. The blast radius is bounded by the eligibility rule instead:

- only at the `EVIDENCE_REVIEW` human gate, on approval;
- only for `fact` claims materialized from a valid plan approval certificate;
- only when the author declared them `critical`;
- `derived_signal` (architecture) and `hypothesis` (standalone review) claims are
  never gate-eligible and remain advisory;
- a session whose implementation has only `ceremony_only` risk triggers is
  unaffected.

For an implementation with a specific persisted risk trigger, FlowGuard also
requires at least one certificate-authorized critical `fact` claim before final
evidence approval. The trigger taxonomy is `state_integrity`, `audit_authority`,
`identity_boundary`, `approval_authority`, `policy_authority`, `migration`,
`distribution_integrity`, and `command_contract`. A trigger is computed from the
actual changed files, bound to the implementation digest, and rendered to the
reviewer. Multiple specific triggers are retained. `ceremony_only` preserves the
existing HIGH-RISK ceremony for broad sensitive surfaces but never creates this
claim requirement.

Assessments persisted before risk triggers existed are treated as superseded at
the final gate. Request changes, record a fresh implementation assessment, and
then request approval again; FlowGuard does not infer a trigger from an old path
list at the approval boundary.

Everything else remains owned by ReviewFindings, obligations, attestations, and
validation. ProofGraph adds one blocking condition; it replaces no authority.

Because a critical claim requires executed adversarial evidence, a critical
declaration without a counterexample check could never become `PROVEN`. Such a
declaration is therefore rejected when it is authored
(`PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE`) rather than blocking the approval later.

If a current plan approval certificate authorizes a critical declaration but its
claim is absent from the persisted ProofGraph projection, final evidence approval
blocks with `PROOFGRAPH_EVALUATION_UNAVAILABLE`. A missing projection is never
interpreted as an empty declaration set; request changes and restore the
evaluation before approval.

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
      critical: true,               // required
      counterexampleCheckId: "security" // required for critical claims; a distinct check whose FAILURE contradicts the claim
    }
  ]
})
```

The tool persists the contract and the derived projection to session state and
returns the evaluated projection.

When a certificate-bound plan contract already exists, manually declared claims
are appended without rewriting the materialized plan claims or their evidence.
Manual claims may resolve to `fact` when they cite a governing authority, but
they carry no approval certificate and therefore remain advisory at the final
gate.

## Falsification (counterexamples)

Counterexamples are evidence-bound, never asserted. A claim's
`counterexampleCheckId` names a check whose **failure** would contradict it. The
outcome is derived from the executed validation result:

- the attempt failed → `contradicted` (the falsification succeeded → claim
  `CONTRADICTED`, which wins over any passing positive evidence);
- the attempt passed → `supported`;
- missing → `not_verified`.

A **critical `fact` claim additionally requires** a `supported` counterexample from a
check distinct from its positive check:
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
disagree" class. They are both standalone reports **and** evidence providers:

- **Registration consistency** (`command-registration`, `structural_assertion`) —
  every installed command's template body, target tool, and workflow command is
  actually registered.
- **Config-default consistency** (`config-defaults`, `schema_compare`) — the
  config schema normalizes a minimal config, every required top-level key is
  present after defaulting, and re-parsing the normalized defaults is stable.

A claim opts in with `structuralSurface`, which adds a `structural_surface`
evidence reference **and** the matching provider kind to `requiredEvidence`. The
result is bound to a canonical digest over the covered registry/schema **data**
(not source files, so it behaves identically in a checkout and an installed
package). When that surface changes, the prior pass becomes `STALE` and can no
longer satisfy the claim.

## Selective semantic mutation

Mutation evidence is **recorded, never executed** by FlowGuard. A repo-wide
per-PR mutation run is documented as unreliable and is deliberately not a
requirement; instead an already-produced Stryker report
(`reports/mutation/mutation.json`) is ingested for explicitly selected profiles:

| Profile                | Covered surface                    |
| ---------------------- | ---------------------------------- |
| `proofgraph-evaluator` | `src/audit/proofgraph/evaluate.ts` |
| `proofgraph-gate`      | `src/audit/proofgraph/gate.ts`     |

A claim opts in with `mutationProfile`, which adds `fault_injection` to
`requiredEvidence`. Survivor semantics are explicit:

- `Survived` and `NoCoverage` are **survivors** → failing evidence;
- `Killed` and `Timeout` are detected;
- `CompileError`, `RuntimeError`, `Ignored`, `Pending` are **excluded**, never
  silently counted as detected.

No recorded report, an uncovered profile, or an unknown profile yields
`unavailable` evidence (`NOT_VERIFIED`) — never a pass-by-fallback. Mutation
evidence binds to the implementation digest, so it goes `STALE` with the
revision.

## Inspecting the ProofGraph

`flowguard_status({ proofGraph: true })` returns the projection. Reading it is
read-only and never gates; the gate itself acts only at the `EVIDENCE_REVIEW`
approval. Beyond per-claim verification states and freshness it
surfaces explicitly, rather than merely implying:

- `counterexamples` — every executed adversarial outcome with its bound digest
  and a `stale` flag;
- `mutation` — recorded per-profile verdicts including surviving mutant ids
  (empty when nothing was recorded, never fabricated);
- `unresolvedAssumptions` — each non-`PROVEN` claim with a reason distinguishing
  an unsourced assumption, a falsification, an errored provider, missing
  evidence, and superseded (stale) evidence;
- the registration and config-default consistency reports and the gate decision
  (`enforced` is a constant compatibility field; enforcement is unconditional).
