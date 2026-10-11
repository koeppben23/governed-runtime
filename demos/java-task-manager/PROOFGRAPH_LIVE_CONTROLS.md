# Critical ProofGraph Live-Control Contract

These release-evidence controls are separate from the six-scenario matrix. They
must execute through actual OpenCode/FlowGuard tools on one unchanged integrated
HEAD with a checksummed installed artifact, fresh sessions, complete validated
parent/reviewer transcripts and canonical state/audit. Keep explicit thinking
disabled for the requested DeepSeek runs and record the effective wire settings.

## Prerequisite: current canonical contract

Obtain claim declarations, assertion identities and active check capabilities
from the integrated runtime's current schemas and registered tools. The schema
authorities are `src/state/proofgraph-approval.ts`, `src/state/proofgraph.ts` and
`src/state/assertion-identity.ts`; JUnit identity/capability is owned by the provider
registry and codec. Do not invent a second declaration format or assertion codec.

Evidence roles must remain distinct under the integrated soundness contract:
the same observation must not be counted as both positive and falsification
evidence. Check actual role/binding diagnostics, not just check names or verdicts.
A successful result against an obsolete contract is not admission evidence for its
replacement.

## Executable controls

`run-live-claim-controls.mjs` runs both cases on real OpenCode/FlowGuard tools with
the same pinned toolchain and checksummed tarball as `run-live-matrix.mjs`:

```bash
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","provider":{"deepseek":{"models":{"deepseek-flash":{"options":{"reasoningEffort":"none","thinking":{"type":"disabled"}}}}}}}' \
FLOWGUARD_REVIEWER_EFFORT=none \
node demos/java-task-manager/run-live-claim-controls.mjs \
  --root /tmp/flowguard-claim-controls --model deepseek/deepseek-flash
```

Before `/start`, each case receives the same committed fixtures: a documentation
ticket and two JUnit classes — a positive assertion
(`UsageNotesHintTest#documentsTestCommand`) and an adversarial falsification probe
(`UsageNotesFalsificationProbeTest#noConflictingCommandIsDocumented`) that does not
repeat the positive assertion. Both checks (`test`, `build`) execute real Maven so
the two evidence roles come from distinct executions and attempts. A critical
`specific_behavior` plan claim binds positive `test` and adversarial `build` to the
adversarial assertion. The runtime mints the claim id, review evidence and approval
certificate. The workspace opts into reduced ceremony so the evidence gate is the
real final gate.

## Positive case

1. Create the honest Java/JUnit fixture before starting governance. Record a task
   with a concrete behavioral requirement and an executable assertion for it.
2. Submit a complete plan containing a retained **critical specific-behavior**
   claim, its claim-specific assertion binding and required falsification contract.
3. Complete the full independent review and ordinary plan approval. Retain the
   runtime-minted claim id and approval-certificate binding through implementation.
4. Execute the real required checks and observations. Require the exact scoped
   assertion to be `passed`; verify provider id, local id, attempt, subject digest,
   freshness and evidence-role bindings.
5. Require a governing critical `fact` with `PROVEN` at the evidence gate, then
   ordinary approval, COMPLETE and an independently verified completion package.

For a reduced-path F1 control, the implementation-review waiver must be the actual
POST_IMPL_VERIFIED_TRIVIAL runtime decision after all required post-implementation
checks. No driver may force the reduced transition or omit a required review.

## Negative case: aggregate PASS is insufficient

Use a separate fresh session with the same retained critical declaration and
correct governing provenance. Arrange an honest check execution where the
overall check is green but the exact scoped assertion does not supply a passing
observation — for example, a genuine JUnit `skipped` result. Capture the real
Maven/Surefire report through the registered provider; never edit a report or
insert fabricated validation evidence.

The negative evidence must show all of the following together:

- current implementation-scoped required checks are green;
- the original critical claim remains certificate-bound, not withdrawn, replaced
  by an advisory hypothesis, downgraded or made stale;
- the required scoped evidence is actually absent/non-passing in the real report;
- the critical claim is not PROVEN and the canonical ProofGraph gate blocks it;
- an actual approval attempt is rejected at that gate with
  PROOFGRAPH_CRITICAL_FACTS_UNPROVEN, leaves the phase/decision unapproved and
  creates no completion package.

If an earlier admission, check-execution or review gate blocks the scenario,
preserve that failure as evidence but mark this specific final-gate proof
NOT_VERIFIED. It is not interchangeable with the required ProofGraph denial.
No override, claim withdrawal, fabricated reviewer acceptance or state edit may
be used to reach the desired result.

## Status

Verified on the integrated head with DeepSeek V4.1 Flash and explicit thinking
disabled (76 wire requests, 3 structured, 0 non-200). Both controls passed with
real host sessions and validated parent/reviewer transcripts:

- **claim-positive:** the retained critical claim reached `PROVEN` with the
  adversarial assertion `passed` and both real checks green, passed ordinary
  approval, and its `/export` package independently verified (`381fd11dee76…`).
- **claim-negative:** both checks green, the adversarial assertion genuinely
  `skipped`, the claim `NOT_VERIFIED`, and the real approval was denied with the
  exact `PROOFGRAPH_CRITICAL_FACTS_UNPROVEN` at unchanged `EVIDENCE_REVIEW`; the
  persisted review decision was unchanged and no package was created.

Full mutation admission remains a separate requirement with its own selectors and
records. A correctly blocked negative case is a passed control, not a completed
development workflow.

## Risk-trigger coverage controls

`demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs` runs #1074's
coverage invariant on an isolated minimal Maven repository whose governed
artifact lives under `src/state/` (canonical classification: HIGH-RISK +
`state_integrity`). The fixture's Maven wrapper is copied from the Java seed; the
fixture itself holds only the project files, the JUnit assertions and the ticket.

```bash
node demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs \
  --root /tmp/flowguard-risk-trigger --model deepseek/deepseek-flash
```

Both cases carry the same critical, certificate-authorized fact claim; only the
approved claim set differs:

- **risk-uncovered:** the claim does **not** declare `coversRiskTriggers`. With the
  trigger detected and a valid claim present, the real approval gate must deny with
  exactly `PROOFGRAPH_RISK_TRIGGER_UNCOVERED` — never an earlier precondition
  (`CERTIFICATE_INVALID`, `EVALUATION_UNAVAILABLE`, `RISK_ASSESSMENT_STALE`,
  `CRITICAL_FACT_REQUIRED`).
- **risk-covered:** the claim declares `coversRiskTriggers: ['state_integrity']` as
  part of the approved plan claim set; the same trigger must reach `PROVEN` and
  pass ordinary approval.

### Recorded live evidence

DeepSeek V4.1 Flash with thinking disabled throughout; `state_integrity` detected
from the real implementation change in every run; no runtime or demo change.

- `bc3cee7a` (initial runner): one combined run reported 2/2 PASS;
  `risk-covered` export `0385c0edd52e…`.
- `6aa154a5` (strict oracles: full evidence contract, role-specific attempt refs,
  toolchain/tarball/build identity, package-absence):
  - `risk-uncovered` PASS — run root `flowguard-risk-trigger-6`: PROVEN claim
    verified before the attempt, denial exactly `PROOFGRAPH_RISK_TRIGGER_UNCOVERED`
    at `EVIDENCE_REVIEW`, `archiveDirContents: []`.
  - `risk-covered` PASS — run root `flowguard-risk-trigger-5`: `PROVEN`,
    `COMPLETE`, export `fb0f7d638b29…`.
  - A single combined 2/2 run on this HEAD stayed **NOT_VERIFIED**: the model
    intermittently submitted no plan or the plan review hit a terminal capture
    failure, which the runner reports fail-closed.
- `68a26b74` (role-specific attempt refs): `risk-covered` PASS — run root
  `flowguard-risk-trigger-7`, export `6c76e6b3dde1…`, with the positive attempt
  bound only to `evidenceRefs` and the adversarial attempt only to
  `counterexampleRefs`. In the same run `risk-uncovered` was rejected by the
  strict claim-identity check because the model altered `authoritySectionId`;
  that rejection is the harness failing closed on a deviating declaration, not a
  gate defect.

Each evidence root keeps canonical state/audit, validated parent/reviewer
transcripts, the provider receipts and the recorded metadata (checkout head,
tarball SHA-256, installed build).
