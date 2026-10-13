# Demo Assurance — forensic controls

This document records the forensic review of the live-demo harness on
`fix/1078-evidence-approval-preconditions` (`57063abe`) and the corrections in
this change. The product ProofGraph/gate semantics are untouched; only the
demonstration, recovery and evidence-classification machinery changed.

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

## Contract for the runners

- Recovery evidence is occurrence-bound; unreadable governed output never
  grounds a success claim.
- `review_exhausted` is a governed terminal outcome. Positive proofs become
  `NOT_VERIFIED`; only the deliberately uncovered old replan control may use
  `/override-approve`, and only with `--allow-old-plan-override`.
- Continuations are state-driven: transport recovery (same frozen obligation),
  bound-verdict submission, and a regular revision after a consumed
  `changes_requested` are distinct; progress is proven by obligation, findings,
  iteration, completion or plan version — not by any state digest change.
- A correctly refused negative control is `CONTROL_PASSED`, never `COMPLETE`.

## Running everything

```bash
demos/run-all-demos.sh /tmp/flowguard-demos-run
```

The wrapper runs one dry-run environment gate (pins, npm-10 compatibility with a
canary install, isolation, artifact checksum, provider ping), then the matrix,
claim controls, risk-trigger controls and the replan recovery sequentially with
fresh roots, and exits `0` (accepted evidence), `2` (`NOT_VERIFIED`) or `1`
(`FAILED`). Existing evidence directories are never overwritten.
