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

`run-live-claim-controls.mjs` runs one case per invocation on real
OpenCode/FlowGuard tools with the same pinned toolchain and checksummed tarball
as `run-live-matrix.mjs`. Use a separate root and service lifecycle for each
case:

```bash
OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","provider":{"deepseek":{"models":{"deepseek-flash":{"options":{"reasoningEffort":"none","thinking":{"type":"disabled"}}}}}}}' \
FLOWGUARD_CLAIM_CASES=claim-positive \
node demos/java-task-manager/run-live-claim-controls.mjs \
  --root /tmp/flowguard-claim-positive --model deepseek/deepseek-flash

OPENCODE_CONFIG_CONTENT='{"$schema":"https://opencode.ai/config.json","provider":{"deepseek":{"models":{"deepseek-flash":{"options":{"reasoningEffort":"none","thinking":{"type":"disabled"}}}}}}}' \
FLOWGUARD_CLAIM_CASES=claim-negative \
node demos/java-task-manager/run-live-claim-controls.mjs \
  --root /tmp/flowguard-claim-negative --model deepseek/deepseek-flash
```

Run these commands sequentially; the dedicated service requires an unused
`127.0.0.1:49375`. Supply provider credentials in the environment. OpenCode V2
selects reasoning through the native model variant/configuration and rejects
`FLOWGUARD_REVIEWER_EFFORT`; do not export it. The setup installer is pointed
at an absent run-local service record, so it cannot restart the user's shared
service; the runner starts and verifies its own child. Native `/start` is
dispatched through that child's session command API; prompt templates continue
through the headless CLI. The runner
sets the JUnit skip in the negative case's actual service process and removes
any inherited skip from the positive case. It will not reuse a running service.
The negative approval is accepted only with a unique audit refusal and its
closing error record, a complete session-bound audit window, and unchanged
persisted state. Ticket adoption and plan creation are separate turns: `/task`
must leave the exact repository ticket in `TICKET` with no plan before `/plan`
is dispatched. The shared plan prompt treats the `-DskipTests` counterexample as
hypothetical plan reasoning only; it is never added to the delivered notes. A transport failure or an unanswered final transcript turn is
not a passing control.

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

## Historical observations, not final reference evidence

On checkout `61a3380317404cdef6a9a492e69edcbb94d4cb00` (`demo-harness.v6`,
OpenCode `2.2.5`, Node `22.22.2`, model `deepseek/deepseek-flash`), local
provider-backed runs reported:

| Case                              | Installed tarball SHA-256                                          | Reported outcome                                                                                                |
| --------------------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- |
| `claim-positive`                  | `651c1e757c6721d0434301767751eaa9e289eb29adef8fc11080aa3466e0bd12` | `COMPLETE`; offline verifier accepted export `9c8840ec1a586990309a2db7916e4ccc97063c1471875a05f0d71785150a2752` |
| `claim-negative` (separate retry) | `3f1cab61127ba5d1ada6491e8c78e4ac2f5aa80a030010d405f017e2acf9900e` | `CONTROL_PASSED`; exact `PROOFGRAPH_CRITICAL_FACTS_UNPROVEN` at unchanged `EVIDENCE_REVIEW`; no package         |

The first negative attempt stopped at `TICKET_SOURCE_ORIGIN_CONFLICT` and did
not verify the expected denial. The successful runs used different tarballs;
they do not establish a matched final reference run. After harness acceptance
and integration, pass the same `--tarball` (with its checksum sidecar) to both
invocations on the integrated HEAD. Original verification and Integrity A/B
must then use that new positive export. Independent review of the historical
local originals and final reference verification are `NOT_VERIFIED`.

On integrated commit `466d9570d3d69958939649d6e76fb44c7b5a32a6`, both cases used
tarball `ec006e4a43f423b93a78acfd3ece8909beda7e4cb76678ba629a3cc98913dc0e`.
The negative case passed with the exact ProofGraph denial and no export. The
positive was `NOT_VERIFIED` before approval: the harness's preflight recovery
expected an obsolete invocation field, although the product had persisted the
bound V2 acceptance. That run produced no package. Re-evaluating its existing
evidence read-only verifies the harness correction, not a live control. Both
cases must be run again on the accepted integrated fix with one new artifact.

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
