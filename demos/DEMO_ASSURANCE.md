# Demo Assurance — forensic controls

This document records the forensic review of the live-demo harness beginning on
`fix/1078-evidence-approval-preconditions` (`57063abe`) and subsequent corrections.
The product ProofGraph/gate semantics are untouched. The v2 follow-up also fixes
reviewer prompt context and installed Task-return guidance.

## Review-context and capture follow-up (harness v2)

- Architecture reviewer prompts retain separately submitted claim IDs, statements,
  required review evidence and assumptions. A real MADR pipeline regression checks
  that each declaration appears once; the nine development/risk controls do not
  themselves exercise architecture review.
- Every native Task return is routed again through terminal, authorized retry and
  completed branches. Only completed dispatches require `reviewExecution`;
  retry envelopes need neither `reviewExecution` nor `reviewInvocation` and
  authorize a fresh Task, not acceptance.
- Transcript capture attempts every parent/reviewer target independently and keeps
  a partial `transcripts` manifest, current `transcriptErrors` and cumulative
  `transcriptCaptureAttempts`. PASS still requires all targets to validate.
  Successful exports receive a SHA-256 receipt. Resume revalidates those bytes,
  session, parent and canonical workspace before reuse. Missing/invalid receipts,
  truncated JSON and modified bytes are retained; retries use numbered attempt
  paths and record rejected predecessors in the new receipt. Failure-path capture
  never changes the original FAILED/NOT_VERIFIED result.
- `recoveryObservations` separates `observed` denials and
  `pending_verification` tool-only successes/re-arm authorizations from
  `recoveredDenials` with `status: proven`. A fresh re-arm is not a completed review.
  Next-step proofs carry the exact denial occurrences. The performance reader
  requires operation-bound same-turn proofs or proven occurrence-bound next-step
  witnesses; overlapping call/model spans and shared recovery turns are charged
  once. Export metrics use digest-checked manifest references, never arbitrary
  attempt files. Old unqualified recovery entries are not credited.
- Measurements record `demo-harness.v2`; do not combine them with v1 samples.
  These regression checks do not constitute a new full live-matrix run.

## Confirmed harness findings (F1–F10)

| #   | Finding                                                                                                                                              | Fix                                                                                                                                                                      |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F1  | Same-turn recovery was attributed per code/tool, not per denial occurrence: a denial after the last successful call could still count as `recovered` | `sameTurnRecoveryProofs()` in `demos/lib/transcript.mjs`: recovered iff a LATER invocation of the same governed tool succeeded; every later open denial stays `unproven` |
| F1b | The controlled negative probe used the same coarse code list, so a hidden extra denial could be missed                                               | `assertExpectedDenial()` refuses to certify when a governed payload is unreadable                                                                                        |
| F2  | `run-live-risk-trigger-controls.mjs` and `run-live-replan-recovery.mjs` never finished an active plan review after one `/plan` turn                  | `convergePlanGate()` drives the persisted gate with at most two extra host turns                                                                                         |
| F3  | Denials/re-arms were detected with formatting-sensitive regexes (`"error":true`)                                                                     | Structured JSON parsing with an explicit `unreadable` trust result                                                                                                       |
| F4  | The claim negative control wrote `packages: []` without checking the archive directory or `exportCompletionEvidence`                                 | Shared `assertNoCompletionPackage()`; the claim negative path now checks the real directory and state                                                                    |
| F5  | The positive claim oracle did not verify the positive assertion, distinct attempts, role-specific refs or freshness                                  | Shared `assertProofEvidence()` used by claim and risk controls                                                                                                           |
| F6  | The installer lock was global even for repo-scoped demo installs                                                                                     | `run-all-demos.sh` sets `FLOWGUARD_INSTALL_LOCK_PATH` per run root (scope stays repo)                                                                                    |
| F7  | A legitimately persisted `review_exhausted` was reported as an "unexpected tool-level block"                                                         | `persistedReviewExhausted()` classifies the override gate as `NOT_VERIFIED` for positive proofs                                                                          |
| F8  | `run-live-claim-controls.mjs` never asserted the pinned toolchain (`--check` was a no-op)                                                            | `assertToolchain(pins)` is enforced                                                                                                                                      |
| F9  | The replan usage header did not mention `--allow-old-plan-override`                                                                                  | Usage header documents the explicit old-control override                                                                                                                 |
| F10 | A correctly refused negative control was counted as a `COMPLETE` workflow                                                                            | Result taxonomy: `COMPLETE` / `CONTROL_PASSED` / `NOT_VERIFIED` / `FAILED`; matrices report counts separately                                                            |

## Read-only trace of the failed live reviews (2026-10-12)

Source: local evidence `audit.jsonl` (`review:subagent_invoked`,
`review:obligation_fulfilled`), the persisted session state and the raw turn
transcripts. All attempts below had `structuredOutputUsed: true` and bound
`findingsHash` where a verdict existed.

| Scenario               | Dispatches                                                   | Capture                                                                                                                    | Verdicts               | Persisted                                                          | Classification                                                                                                                                |
| ---------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- | ---------------------- | ------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| claim-negative (run 1) | 3 obligations                                                | structured, `completed: true`                                                                                              | `changes_requested` ×3 | `PLAN`/`pending`                                                   | loop was ACTIVE; the model did not consume the bound verdict and ended with a self-declared "NOT CONVERGED" (contradicted by persisted state) |
| risk-uncovered (run 2) | 3 + 1 after exhaustion                                       | 3 ok; later attempt `HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION` → host-authorized re-arm (1/1, `retryable`) → failed again | `changes_requested` ×3 | `PLAN_REVIEW`/`review_exhausted`                                   | product fail-closed correct; harness mis-classified the host capture terminal                                                                 |
| risk-covered (run 2)   | 4                                                            | structured                                                                                                                 | `changes_requested` ×4 | `review_exhausted`; plain approve → `GOVERNANCE_OVERRIDE_REQUIRED` | product correct; harness lacked the exhaustion/override outcome model (F7/F10)                                                                |
| replan2 old session    | 3 (third after `REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE`) | re-arm succeeded, verdict bound                                                                                            | `changes_requested` ×3 | `PLAN`/`pending`, directive `PLAN_REVIEW_IN_PROGRESS`              | loop ACTIVE; the model submitted an unbound plan, the denial was correct, the runner lacked continuation handling (F2)                        |

Trace conclusion: no evidence of a successful reviewer output that was not
persisted as a verdict; the failures are harness classification/continuation
gaps plus model-driven review non-convergence. Whether #1080 changes the
frequency or trigger conditions of that non-convergence remains open until a
controlled A/B run with the SAME fixed harness.

## Follow-up review round (PR #1098)

- **Real review evidence:** `classifyPlanGate`/`boundPlanVerdict` decide between
  `SUBMIT_BOUND_VERDICT` and `TRANSPORT_RETRY` from the persisted
  `reviewAssurance` obligation + its linked invocation (never from
  findings/iteration counters, which can carry stale data across cycles). The
  progress key tracks obligation lifecycle (`pending → fulfilled`, invocation
  link, consumedAt) and the latest attempt identity.
- **Transcript trust:** JSONL framing losses are tracked explicitly and, like
  unreadable governed output, abort the proof with `NOT_VERIFIED` — a later
  terminal state cannot launder an untrustworthy turn.
- **Product byte binding:** the wrapper builds ONE immutable tarball, records
  its SHA-256, canary-installs exactly that artifact and hands the same
  `--tarball`/`--product-sha` to every runner; each runner verifies the
  installed product identity. The replan runner extracts the installer CLI from
  the bound tarball for its second workspace instead of using the harness
  checkout's `dist/cli/install.js`.
- **Run lease:** `demos/lib/run-lease.mjs` acquires an exclusive, token-checked
  lease BEFORE the wrapper's first build and releases it on every exit.

## Review rounds (PR #1098)

- **Lease owner is the wrapper:** the lease file is the atomic mutex (`wx`
  create) and records the long-lived wrapper PID (`--pid $$`) plus a unique
  token. Release is only possible with the matching token (`force-remove` is
  the separate administrative operation for a provably stale lease); a dying
  first wrapper can never delete a successor's lease. A stale lease is reported
  for explicit removal — automatic reclaim is racy because a second process can
  then delete a successor's fresh lease. Cross-process exclusivity,
  tokenless/foreign release, and concurrent stale-reclaim blocking are covered
  through the CLI boundary.
- **Signal/exit contract:** `demos/lib/signal-exit.sh` converts INT/TERM into a
  defined termination: the controlled demo process group is signalled
  (`kill -TERM -- -PGID`, escalating to KILL). Both waiting phases probe the
  negative PGID, including after the leader dies. Cleanup releases the lease
  only after confirmed group absence; inability to establish that retains the
  lease and fails the run. Processes that deliberately create a separate session
  are outside this group contract. The regression includes a TERM-resistant
  grandchild and checks group absence at the cleanup boundary. The wrapper enables job
  control (`set -m`), tracks `ACTIVE_CHILD_PGID` and runs each demo in the
  background with `wait` so traps execute promptly. Bootstrap, build, preflight
  and the variants script use the same lifecycle helper.
- **Review-stage classification:** reviewer capture/consistency blocks —
  including `SUBAGENT_UNABLE_TO_REVIEW` and `SUBAGENT_FINDINGS_VERDICT_MISMATCH`
  — classify a positive proof as `NOT_VERIFIED`, never as a demo contract
  violation; the evidence is preserved either way.
- **Administrative removal is fail-closed:** `forceRemoveLease` refuses a lease
  whose owner is alive or whose expected owner identity does not match, and
  asks for manual removal when the lease file is unreadable; only a provably
  stale lease can be removed.
- **Replan installer runs from an isolated npm prefix:** an extracted tarball
  has no `node_modules`; `demos/lib/product-cli.mjs` installs the bound tarball
  into `<root>/.tooling/product-prefix` and executes the CLI from there, with a
  dependency smoke test proving resolution. BOTH replan sessions (old and new)
  are driven through `convergePlanGate`; only a persisted `reviewer_accepted`
  leads to the ordinary approval.
- **Attempt identity in the progress key:** `reviewAssurance.attempts` (latest
  attempt id/status + count per obligation) are part of the fingerprint, so an
  authorized re-arm alone counts as progress instead of a false `STALLED`.
- **Operation-bound recovery control flow:** only a same-turn recovery with a
  coherent typed identity (`same_turn_operation_recovery`) resolves the denial
  in-turn. A later success without an operation binding is recorded as
  `later_tool_success` and moved into `awaitingRecovery`: an independent
  operation-scoped persistence witness from the next required step is needed to
  resolve it. For plan/ADR approval it freezes the subject/revision and the
  accepting review's obligation, invocation and attempt. Only the expected
  approval command and a new certificate binding exactly that subject and
  review may resolve it. A generic session-file digest change, foreign
  certificate or unrelated audit update cannot. Unavailable witnesses stay
  unproven. Structured re-arms require `retryable: true`; terminal supersession
  additionally requires the same explicit obligation and a fresh attempt.
  Claim, subject and obligation identities are compared by type: a matching
  claim cannot hide a conflicting plan digest. The matching invocation is
  searched across later successes; an earlier foreign success cannot preempt it.
  Retryable hints without complete obligation/attempt identities are retained
  as `retryHints` observations, never credited as `structured_rearm`.
- **Exit-code aggregation:** `demos/lib/aggregate-status.mjs` maps 0 to success,
  2 to `NOT_VERIFIED` and any other code (127, 137, signals) to `FAILED`, with
  FAILED outranking NOT_VERIFIED; the mapping is unit-tested and used by the
  wrapper for the runners and the variants script. The wrapper aborts when the
  product build fails.

## Contract for the runners

- Recovery evidence is occurrence-bound; unreadable governed output never
  grounds a success claim. `flowguard_help` is the single governed tool whose
  by-design output is human-readable text (verified against real transcripts),
  so it is not a trust defect; every action tool must return a JSON envelope.
- `review_exhausted` is a governed terminal outcome. Positive proofs become
  `NOT_VERIFIED`; only the deliberately uncovered old replan control may use
  `/override-approve`, and only with `--allow-old-plan-override`.
- Continuations are state-driven: transport recovery (same frozen obligation),
  bound-verdict submission, and a regular revision after a consumed
  `changes_requested` are distinct; progress is proven by obligation, findings,
  iteration, completion or plan version — not by any state digest change.
- A correctly refused negative control is `CONTROL_PASSED`, never `COMPLETE`.
- An unresolved recoverable denial — including plan/implement call-shape guards
  such as `INVALID_PLAN_TOOL_SEQUENCE`, `INVALID_IMPLEMENT_TOOL_SEQUENCE`,
  `PLAN_APPROVE_WITH_TEXT` and `PLAN_SUBMISSION_REQUIRED`, and the admissibility
  guards `COMMAND_NOT_ALLOWED` / `WRONG_PHASE` — is `NOT_VERIFIED`
  with its occurrence evidence preserved. `FAILED` is reserved for a proven
  wrong denial code, contradictory evidence or an unexpected unknown block.
- An `/implement` turn that records no implementation (for example because the
  host auto-rejected the author's edit) is incomplete author work: the risk
  controls re-enter `/implement` at most once and then report `NOT_VERIFIED`.
  Only a recorded implementation is judged by the trigger and evidence oracles,
  so a missing `state_integrity` trigger on a real change stays `FAILED`. An
  author that stops at `IMPL_REVIEW` uses the same bounded resume as the
  matrix (`completeImplementationReview`).

## Recorded plan-review counter cases

`review-counter-cases/plan-review-false-positives.json` records plan-review
false positives from live validation runs: the reviewer assertion, its
classification, and the evidence that refutes it. Repository-checkable
references (script bodies, test methods, observation authority, fixture
wording) are verified by `src/documentation/__tests__/review-counter-cases.test.ts`.
A recorded case is a counter-example, not evidence of corrected reviewer
behavior: every case stays `NOT_VERIFIED` until a later live run is checked
against it.

## Running everything

```bash
demos/run-all-demos.sh /tmp/flowguard-demos-run
```

The wrapper runs one dry-run environment gate (pins, npm-10 compatibility with a
canary install, isolation, artifact checksum, provider ping), then the matrix,
claim controls, risk-trigger controls and the replan recovery sequentially with
fresh roots, and exits `0` (accepted evidence), `2` (`NOT_VERIFIED`) or `1`
(`FAILED`). Existing evidence directories are never overwritten.

## Latency baseline (read-only)

```bash
node demos/lib/perf-baseline.mjs <run-root> [<run-root>...] --json <out.json> --md <out.md>
```

`demos/lib/perf-baseline.mjs` reads archived run roots only (`evidence/` and,
when present, FlowGuard diagnostic logs under `workspaces/*/.opencode/logs/`),
never the host database, and refuses to write inside an analyzed root. The
output carries identifiers, codes, labels and numbers only.

- Every observed denial is classified per occurrence (`controlled_negative`,
  `avoidable_call_shape`, `governance_feedback`, `wait_state`, `unexpected`).
  `controlled_negative` requires either the fixture's `requiredControls` entry
  for that flow or the runner-declared `(step, code)` pair in
  `CONTROLLED_NEGATIVE_STEPS`; any other denial - including another code inside
  a control step - is classified by its own code.
- Extra cost is `attributed` only for an occurrence-bound same-turn recovery
  without a competing denial of the same tool, or a runner-proven next-step
  recovery; otherwise `NOT_OBSERVED`. A legitimate `changes_requested` is a
  review verdict, never a denial.
- Phases come only from observed governed payloads of the same turn; model
  steps only from transcript step events; reviewer Task and structured
  follow-up are split at FlowGuard's follow-up prompt in the host export.
- Every reviewer child is exported, including dispatched attempts that ended
  stale/failed and never fulfilled; a flow that fails still captures its
  transcripts on the failure path. `denialCounts` are per-OCCURRENCE and only
  for GOVERNED tool outputs — a denial envelope from a foreign tool is never a
  control proof.
- Measurements record the harness version and the product ProofGraph contract
  version, and report host-turn wall time, reviewer-child elapsed time, model
  spans, and process overhead separately.
- Comparable runs share flow, model, host version and build. p95 is
  `insufficient_sample` below 20 runs, `exploratory` from 20 to 99 and
  `descriptive` from 100; individual values and the median are always shown.
