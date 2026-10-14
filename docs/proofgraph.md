# FlowGuard ProofGraph

The ProofGraph makes a change's critical claims traceable from an approved
source through executed, revision-bound evidence to an explicit verification
state. It improves reviewability; it does **not** claim correctness.

## Proof-status semantics

Each declared claim is evaluated to exactly one state. The evaluator is
deterministic and applies this precedence (first match wins):

| Order | State                | Condition                                                                                                                            |
| ----- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| 0     | `NOT_VERIFIED`       | Contradictory counterexample history (`counterexample_conflict`), including a falsification followed by a pass at the same revision. |
| 1     | `NOT_VERIFIED`       | Missing provenance.                                                                                                                  |
| 2     | `CONTRADICTED`       | A selected fresh counterexample falsifies the claim.                                                                                 |
| 3     | `BLOCKED`            | A fresh counterexample is blocked, or a current positive provider errored. Error takes precedence over unavailable.                  |
| 4     | `NOT_VERIFIED`       | A positive provider is unavailable.                                                                                                  |
| 5     | `UNPROVEN`           | A positive provider failed on the current revision.                                                                                  |
| 6     | `NOT_VERIFIED`       | Specific-behavior binding or independent evidence roles are missing.                                                                 |
| 7     | `PROVEN`             | Every fresh positive and adversarial requirement is satisfied; a solely stale adversarial history yields `STALE`.                    |
| 8     | `NOT_VERIFIED`       | Required adversarial evidence is unresolved.                                                                                         |
| 9     | `STALE` / `UNPROVEN` | Remaining evidence is superseded, or no sufficient positive evidence exists.                                                         |

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
`critical`. Policy decides **who may approve**, never **whether the evidence is
sufficient**: an automatic approval under `solo`/`team-ci` clears the same
canonical preflight as an explicit human decision, and the generic transition
applier refuses the `EVIDENCE_REVIEW -> EXPORT_READY` edge entirely. The blast
radius is bounded by the eligibility rule instead:

- at every `EVIDENCE_REVIEW -> EXPORT_READY` approval — explicit decision,
  governance override, or policy-automatic;
- the persistence boundary refuses a newly entered `EXPORT_READY` whose
  approval lacks an authentic, single-use admission for the exact predecessor,
  applied transition and evidence basis. This protects writes through FlowGuard's
  persistence API; direct filesystem writes bypass that API;
- only for `fact` claims materialized from a valid plan approval certificate;
- only when the author declared them `critical`;
- `derived_signal` (architecture) and `hypothesis` (peer review) claims are
  never gate-eligible and remain advisory;
- a session whose implementation has only `ceremony_only` risk triggers is
  unaffected.

Plan approval itself is attested: a plan certificate carries an
`explicit_decision` or `policy_auto` attestation bound to the session binding
and frozen policy. Automatic plan approval is minted only from the same bound,
accepted review evidence the explicit rail resolves — an exhausted review is
never certified automatically — and a `policy_auto` certificate carries no
invented human identity.

For an implementation with a specific persisted risk trigger, FlowGuard
requires that **every** detected trigger is explicitly covered by at least one
certificate-authorized critical `fact` claim. Coverage is declared with
`coversRiskTriggers` on the claim; it is never inferred from claim text. The
final gate enforces the coverage relation from the current approval
certificate's declaration set — not from the persisted projection — so a stale
or tampered projection cannot widen certificate-authorized coverage. A `PROVEN` claim
only counts when its provenance binds the current certificate (certificate id,
declaration digest, attestation digest, declaration id, and authority digest)
and appears exactly once in the projection; a claim evaluated under a different
certificate or a duplicated claim is treated as missing. A claim
may cover several triggers, and several claims may split the coverage. A
non-critical or certificate-less claim can never cover a trigger, and a trigger
detected at the final gate but not declared as covered blocks with
`PROOFGRAPH_RISK_TRIGGER_UNCOVERED`. The trigger taxonomy is `state_integrity`,
`audit_authority`, `identity_boundary`, `approval_authority`,
`policy_authority`, `migration`, `distribution_integrity`, and
`command_contract`. A trigger is computed from the actual changed files, bound
to the implementation digest, and rendered to the reviewer. Multiple specific
triggers are retained. `ceremony_only` preserves the existing HIGH-RISK ceremony
for broad sensitive surfaces but never creates this claim requirement and can
never be declared as covered.

Assessments persisted before risk triggers existed are treated as superseded at
the final gate. The same applies when no assessment exists at all: as soon as an
implementation revision is present, final evidence approval requires a risk
assessment bound to that exact revision. Request changes, record a fresh
implementation assessment, and then request approval again; FlowGuard does not
infer a trigger from an old path list at the approval boundary.

Everything else remains owned by ReviewFindings, obligations, attestations, and
validation. ProofGraph adds one blocking condition; it replaces no authority.

Because a critical claim requires executed adversarial evidence, a critical
declaration without a counterexample check could never become `PROVEN`. Such a
declaration is therefore rejected when it is authored
(`PROOFGRAPH_CLAIM_CONTRACT_INCOMPLETE`) rather than blocking the approval later.

The positive check and the counterexample check must be **different checks**,
and they must resolve to **different executions**. A declaration that reuses one
check for both evidence roles is rejected at the write boundary for every
criticality. An already-persisted contract that binds the same check (even from
two distinct attempts) or the same validation attempt to both roles never
becomes `PROVEN`; its diagnostic is `evidence_role_collision` /
`PROOFGRAPH_EVIDENCE_ROLE_COLLISION`.

If a current plan approval certificate authorizes a critical declaration but the
claim has no unique, correctly bound source and persisted ProofGraph evaluation
(absent, duplicated, or bound to a different certificate), final evidence
approval blocks with `PROOFGRAPH_EVALUATION_UNAVAILABLE`. A missing projection
is never interpreted as an empty declaration set; request changes and restore
the evaluation before approval. The same exactly-once rule applies to claim
ids: an authorized critical claim must occur exactly once in the declared
contract and exactly once in the projection with a matching certificate
binding. Duplicate occurrences are never resolved by first/last match.

Structured assertion evidence follows the same fail-closed identity rule. A
provider-scoped assertion identity (provider, local id) that occurs more than
once inside one extraction cannot select a result by order: the attempt's
evidence is invalid for both the positive and the adversarial role, binding
reports `assertion_identity_ambiguous` /
`PROOFGRAPH_ASSERTION_IDENTITY_AMBIGUOUS`, and a cached `PROVEN` projection that
references it is re-evaluated to a blocked, non-proven state. A provider
mismatch inside one extraction keeps precedence
(`assertion_provider_mismatch` / `PROOFGRAPH_ASSERTION_PROVIDER_MISMATCH`).
`exitCode: 0`, `passed: true`, or a valid cryptographic binding never upgrade
ambiguous structured evidence into usable proof; the raw observations remain
auditable and only their qualifying force is removed.

## Declaring claims

Installed OpenCode, Claude Code and Codex planning instructions share the same
claim guidance as the plan tool's input description. `specific_behavior` claims
need claim-specific observations; `suite` claims need explicit full-check scope
and registered aggregate capability for adversarial evidence. The illustrative
`build`/`test` example is valid only when those checks are active and the selected
candidate can bind the named assertion. Never invent an assertion identity.

Plan `targetPaths` are advisory forecasts and can be partial or unknown. Declare
explicit `coversRiskTriggers` for known applicable specific risks on critical
claims whose behavior actually covers them. The actual implementation assessment
can discover additional risks; it never silently widens approved coverage.

`flowguard_declare_contract` (admissible in `IMPL_VALIDATION` / `IMPL_REVIEW`)
records the claims a change asserts. Each claim is bound **fail-closed** to an
implementation validation attempt at the current revision — an unsourced claim
is rejected (`PROOFGRAPH_CLAIM_EVIDENCE_UNRESOLVED`), never recorded.

```
flowguard_declare_contract({
  claims: [
    {
      statement: "the user creation path rejects invalid input",
      checkId: "test",              // positive execution evidence, not proof by itself
      critical: true,
      claimScope: "specific_behavior",
      counterexampleRequirement: {  // required for critical claims; a distinct check whose FAILURE contradicts the claim
        kind: "assertion",
        checkId: "security",         // must differ from checkId: one execution cannot satisfy both evidence roles
        assertion: {
          providerId: "junit",
          localId: "com.example.UserTest#createsUser"
        }
      }
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

## Recovery when approved claims must change

Evidence repair and authority revision are different operations. With a valid,
satisfiable approved claim, `/request-changes` at `EVIDENCE_REVIEW` returns to
`IMPLEMENTATION`: repair, record with `/implement`, run fresh checks and complete
review. A missing evaluation or stale risk assessment is repaired through that
same product path. Do not edit the projection or assessment in session files.

Missing approved coverage, a structurally unsatisfiable claim, or an invalid
certificate requires a **new governed session**, not an in-place declaration
change. No in-session post-approval replan is available:

1. Preserve the old session identity, plan/certificate digests, detected triggers
   and code changes. On an explicit user instruction, `/abort` terminates the old
   session with its audit trail and historical authority retained.
2. As an operator preparation step, create a separate worktree at the original
   trusted pre-change base. Do not import the task's changes before hydration.
3. Start a new **host session with a different host-session id**, then `/hydrate`
   in that prepared worktree. Verify a distinct FlowGuard session identity and
   `READY`. Hydrate in the old terminal binding is a read-only reload, not a
   restart. A new session on unchanged pre-existing dirty files excludes those
   bytes from its implementation scope and is not a recovery substitute.
4. Run `/ticket`, then `/plan` with the complete corrected declarations and
   applicable coverage. Complete independent review and obtain a new certificate
   under the active policy. This is an independent plan lineage starting at v1,
   not a fabricated v2 of the old lineage.
5. Only in the new authorized `IMPLEMENTATION` step, reapply the preserved changes
   through the regular governed host-mutation contract. Record with `/implement`
   and verify the full intended change scope and fresh risk assessment. An
   out-of-workflow `git apply` is not retroactively authorized by recording.
6. Execute fresh positive and adversarial checks and complete required review
   before evidence approval. Never transfer old certificates, attempts or
   `PROVEN` projections: identical code bytes or claim ids are not new evidence.

If a new host binding or trustworthy pre-change base is unavailable, report the
missing prerequisite as **BLOCKED**. Do not reset authority files or automatically
restart a session. The code change can be preserved without reusing its approval.

Status and contextual help project the canonical approval preflight. A denied
approval is shown as blocked even under an automatic policy; help does not
recommend an approval whose preflight fails. The machine directive and command
admissibility describe legal input routing, not a guarantee that an approval's
evidence prerequisites are satisfied.

### Verification levels

`src/integration/proofgraph-replan-recovery.test.ts` deterministically exercises
two host contexts through real Git, persistence, mutation hooks and executed
checks; reviewer observations use test fixtures. This is CI contract evidence,
**not a live host-session handoff**. A live recovery additionally needs retained
host transcripts for both actual host-session ids, both FlowGuard ids, build SHA,
installed template identity, baseline/scope, the explicit abort, new certificate,
new execution attempts and final approval. Report that live step `NOT_VERIFIED`
unless the complete host workflow was actually rerun.

The opt-in real-host runner is
`node demos/risk-trigger-fixture/run-live-replan-recovery.mjs --root <fresh-dir>`.
It uses the canonical pinned Node/OpenCode toolchain and the configured model,
installs the built artifact, retains every host turn and exports both parent and
reviewer transcripts. Its `replan-recovery.json` reports failure unless the old
session was aborted, terminal hydrate was read-only, a distinct session obtained
a new certificate, identical code was reapplied under governed mutation and new
attempts satisfied final approval. `--check` verifies the toolchain only and is
not live recovery evidence.

The corrected guidance may cause the reviewer to reject the deliberately
uncovered **old** control plan before evidence approval. Only for that negative
control, the operator can explicitly pass `--allow-old-plan-override` to use the
installed canonical override command when its directive requires it. Without
that flag the runner stops; it never silently escalates approval. The recorded
old certificate binding exposes the override. This grants no evidence-approval
bypass, and the new corrected plan must still pass ordinary independent review
and approval.

## Falsification (counterexamples)

Counterexamples are evidence-bound, never asserted. A claim's
`counterexampleRequirement` binds a specific verification check to a
concrete provider-scoped assertion. Only a matching failed assertion can
contradict the claim. The outcome is derived from the executed validation result:

- the matching assertion failed → `contradicted` (the falsification succeeded → claim
  `CONTRADICTED`, which wins over any passing positive evidence);
- the matching assertion passed → `supported`;
- missing or assertion mismatch → `not_verified`.

A **critical `fact` claim additionally requires** a `supported` counterexample from a
check distinct from its positive check:
without a passing executed assertion bound to the declared counterexample identity, the claim
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

**Current capability:** every `mutationProfile` declaration is rejected with
`PROOFGRAPH_CLAIM_UNSATISFIABLE`. No FlowGuard-executed proving mutation provider
exists. The shipped recording/ingestion tool remains usable for visible,
auditable `external_self_reported` observations, which never satisfy positive
proof. The profiles below describe ingestion, not a currently usable proof opt-in.

Mutation evidence is **recorded, never executed** by FlowGuard. A repo-wide
per-PR mutation run is documented as unreliable and is deliberately not a
requirement; instead an already-produced Stryker report
(`reports/mutation/mutation.json`) is ingested for explicitly selected profiles:

| Profile                | Covered surface                    |
| ---------------------- | ---------------------------------- |
| `proofgraph-evaluator` | `src/audit/proofgraph/evaluate.ts` |
| `proofgraph-gate`      | `src/audit/proofgraph/gate.ts`     |

The declaration contract would require `fault_injection` for `mutationProfile`;
the current capability gate refuses that unsatisfiable contract. Survivor semantics are explicit:

- `Survived` and `NoCoverage` are **survivors** → failing evidence;
- `Killed` and `Timeout` are detected;
- `CompileError`, `RuntimeError`, `Ignored`, `Pending` are **excluded**, never
  silently counted as detected.

No recorded report, an uncovered profile, or an unknown profile yields
`unavailable` evidence (`NOT_VERIFIED`) — never a pass-by-fallback. Mutation
evidence binds to the implementation digest, so it goes `STALE` with the
revision.

## Inspecting the ProofGraph

### What ProofGraph does not prevent

- An agent authors the tests and their semantic content; a passing named assertion
  is not proof that the test meaningfully falsifies the claim. Review must inspect it.
- Reports are written by the verification process in the agent-controlled project.
  FlowGuard creates fresh attempt directories, rejects symbolic links and checks
  execution-window timestamps. These are isolation measures, not producer attestation;
  a concurrent process running as the same OS user can still fabricate reports.
- Session state remains plaintext and writable to the local OS user. Schema,
  policy-hash, certified-claim and admission checks enforce consistency through
  the runtime. The shell write barrier catches obvious direct writes and is heuristic.
- Gitignored helper files can influence execution outside the Git-derived implementation
  subject. Declared execution inputs cover known configuration, not every runtime dependency.
- Keyless hashes support comparison with a trusted reference. They do not establish
  authenticity when the adversary can rewrite both data and hashes. Stronger guarantees
  require execution/state attestation outside the agent's reach.

These limits define the bounded adversarial threat model. Diagnosis, evidence
preservation and controlled `/abort` remain available after an integrity incident;
repository mutations are denied until recovery in a distinct governed session.

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
- the registration and config-default consistency reports and the gate decision.

## Human claim vocabulary

The default human surface maps canonical verification states to five
human-readable labels through a single vocabulary authority. Only `PROVEN`
renders as `Verified`; all other states are explicitly non-verified.

| Canonical      | Human            | Glyph |
| -------------- | ---------------- | ----- |
| `PROVEN`       | `Verified`       | `✓`   |
| `UNPROVEN`     | `Not verified`   | `?`   |
| `NOT_VERIFIED` | `Not verified`   | `?`   |
| `CONTRADICTED` | `Failed`         | `✗`   |
| `STALE`        | `Needs re-check` | `⚠`   |
| `BLOCKED`      | `Blocked`        | `⚠`   |

`UNPROVEN` and `NOT_VERIFIED` are compressed to `Not verified` in the default
surface but remain distinct in diagnostic mode — no domain merge.

Evidence requirements are displayed directly from the canonical contract:

- `requiredEvidence` exposes the positive provider kinds (e.g. `executed_test`,
  `fault_injection`) and adversarial evidence categories the evaluator requires.
- `counterexampleRequirement` exposes the assertion/aggregate_check binding
  (`checkId`, `providerId`, `candidateId`) that governs counterexample
  evidence matching.

Claim Resolution displays the canonical evidence requirement contract and
claim-level binding diagnostic. It does **not** reconstruct per-reference
evidence satisfaction.
