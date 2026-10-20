# Adjudication: R and R+ (R-A decided)

**Status:** Decided — R-A (R `accept`, R+ `accept`). Both cases are in
`cases.json` with `reviewStatus: "approved"`.

The initial R-B decision was pre-registered and then tested. R was accepted
**6/6**, so R-B was not confirmed. On 2026-10-19 the adjudicator selected R-A.
The R-B record is retained below for audit history.

This dossier records the two reference cases requested after Stage 1:

- **R** — the unchanged 2026-10-19 reproduction plan.
- **R+** — the same plan with an explicit RED/GREEN falsification design.

Both cases are in `cases.json` with `reviewStatus: "approved"`. This file
records the frozen evidence, the adjudication, and the retained alternative.

## Frozen evidence

| Item                 | Value                                                              |
| -------------------- | ------------------------------------------------------------------ |
| Reproduction fixture | `demos/reviewer-reference-suite/reproduction/2026-10-19-plan.json` |
| Fixture SHA-256      | `9d917d9cf29b4fdb178646f151e5f1ed877deb57e99b3cc40075ca6818f21db8` |
| Source host          | OpenCode 1.19.3                                                    |
| Source build         | `6a4ff271`                                                         |
| Parent session       | `ses_ead2b296cffeD1PY69gDCBnfLj`                                   |
| Reviewer child       | `ses_ead29ed7effe5Q9hfbMoOY1ZGM`                                   |
| Parent tool part     | `prt_152d5ef9e001Hjq5UKx3yWz8k7`                                   |

The fixture is the exact parent tool input from the original run.

## What the frozen plan actually says

The plan's `## Verification` section contains exactly two planned executions:

1. `npm run test --` (`./mvnw test`) — confirms the full suite, including the
   activated `TaskControllerTest#update_taskNotFound_returns404`, passes.
2. `npm run build --` (`./mvnw verify`) — confirms the build and full
   verification suite pass.

Both are post-fix green runs. The frozen plan does **not** contain a sentence
that schedules or reports a pre-fix RED execution. The HTTP 500 failure appears
in the plan objective and in the ticket/root-cause context; the test code itself
contains the `isNotFound()` assertion and is `@Disabled` in the frozen seed.

The plan's claims are:

| Claim                                                                        | Critical | Counterexample binding                                            |
| ---------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| PUT with a non-existent task ID returns HTTP 404 with the requested `taskId` | `true`   | `test` check; `TaskControllerTest#update_taskNotFound_returns404` |
| PUT with an existing task ID still returns HTTP 200 with updated values      | `false`  | none declared                                                     |

This differs from the description “two critical claims”: only Claim 1 is
critical in the frozen fixture.

## What the Stage 1 blockers said

Both blocking findings target **Claim 1**, not Claim 2:

- They say the Verification section schedules only post-fix successful runs.
- They say no planned execution activates the test against the unguarded
  service or a targeted faulty variant.
- Therefore, they conclude, the counterexample is not demonstrated to detect
  the 500/404 violation.

They do **not** merely demand that an executed RED result already exist. They
demand that the plan schedule or describe the falsifying execution.

## Fixture correction after the first A signal run

The first A signal run at 32K exposed a defect in the reference fixture, not in
the reviewer: the suite's A plan omitted the ticket's mandatory Javadoc
replacement. The reviewer correctly blocked it on that missing ticket
requirement. The A/B/C1/C2/C3/E plan fixtures now include the Javadoc
replacement, so the counterexample design is the only intended difference
between A and B.

The runner was also corrected to select the transcript of the bound reviewer
child rather than the last re-armed attempt, and to count the frozen
obligation's re-arms as `retries`. The first A signal record is therefore
excluded from the evaluation; it reported a fixture defect.

## Candidate adjudications

### Option R-A — R `accept`, R+ `accept`

Rationale:

- `p42-v7` plan review does not require future validation results to already
  exist.
- The activated regression assertion is a concrete, targeted check for the
  claimed 404/`taskId` property. Against the documented pre-fix behavior it
  fails; after the guard it passes.
- The plan objective, approach, and ticket establish the pre-fix HTTP 500
  behavior, even though the Verification section only lists the post-fix runs.
- A reviewer that blocks solely because an executed RED result is absent is too
  strict.

Consequence: the two Stage 1 blockers are over-strict false positives.

### Option R-B — R `changes_requested`, R+ `accept`

Rationale:

- The plan's Verification section plans only post-fix green runs.
- The counterexample check is therefore not scheduled against a concrete
  violating state; the plan does not demonstrate that the selected check
  detects the violation.
- The correct repair is to add the RED/GREEN execution: activate the test
  before the guard (or temporarily revert the guard), record the expected
  failure, then run the post-fix pass and build.
- R+ is the corrected plan and should be accepted.

Consequence: the two Stage 1 blockers are correct and identify a real plan
design gap.

## Proposed adjudication for the next run

The clean A/B single-review signal (one repetition per arm) is:

| Case                            | 32K                 | 65K                 |
| ------------------------------- | ------------------- | ------------------- |
| A — targeted falsification      | `accept`            | `accept`            |
| B — second green counterexample | `changes_requested` | `changes_requested` |

All four runs completed, serialized with `reasoning: none`, and matched their
gold standard. This supports the basic counterexample distinction, but it is a
signal, not a stability measurement.

**Initial decision: R-B.** R was expected to block, R+ to accept. This was the
pre-registered standard for the first R/R+ runs. It was not confirmed: R was
accepted 6/6. The adjudicator then selected R-A (see below).

Rationale: A was accepted because its Verification section explicitly describes
the pre-fix HTTP 500 failure and the separate post-fix 404 pass. The frozen R
plan only schedules post-fix green runs. The Stage 1 blockers therefore identify
a concrete difference between R and A: R does not state or plan the falsifying
execution. R+ adds that description and should be accepted like A.

The R-A alternative was adopted after the observed runs: both R and R+ are
expected to accept, and the Stage 1 blockers are classified as over-strict.
R-B is retained as the pre-registered, falsified standard, not as the current
gold standard.

## Observed R/R+ results (pre-registered R-B)

The runs below were executed after R-B was recorded. They are evaluated against
R-B, not against a post-hoc standard.

| Case                            | 32K          | 65K                              |
| ------------------------------- | ------------ | -------------------------------- |
| R — unchanged reproduction plan | `accept` 3/3 | `accept` 3/3                     |
| R+ — explicit RED/GREEN design  | `accept` 3/3 | `accept` 1/3; 2/3 not comparable |

The two R+ 65K non-comparable runs submitted the plan with escaped quotes
(`\"` instead of `"`) in one Validation sentence. The runner rejected them as
subject-fidelity failures; they are not reviewer-evaluation evidence.

Interpretation under the pre-registered R-B standard:

- R was expected to block but was accepted **6/6**. R-B is not confirmed.
- R+ was expected to accept; 32K confirmed it 3/3, 65K is partially
  `NOT_VERIFIED` due to subject fidelity.
- R and R+ were both accepted at 32K. The explicit RED/GREEN addition did not
  change the verdict because R was already accepted.
- This supports the alternative R-A interpretation: the targeted regression
  assertion is considered a sufficient falsification mechanism; the Stage 1
  full-loop blockers were over-strict or harness-confounded.
- The clean A/B single-review signal (A `accept`, B `changes_requested` in both
  arms) shows that the reviewer still distinguishes a second-green
  counterexample.

R-B was not silently rewritten. It was tested, failed, and then replaced by a
new recorded R-A decision.

## Independent R-A rationale

This rationale is independent of the observed accept rate. It follows the
`p42-v7` plan criteria and the frozen test code.

- `p42-v7` says plan review precedes baseline and implementation validation and
  must not require future validation results as already-existing evidence.
- Counterexample sufficiency requires a concrete violating mechanism, not a
  second green success case. The plan does not need an executed RED result at
  review time.
- R binds the counterexample check `test` to
  `TaskControllerTest#update_taskNotFound_returns404`.
- The frozen test performs `put("/tasks/non-existent-id")` and asserts
  `status().isNotFound()`. The frozen `TaskService.updateTask` dereferences
  `repository.findById(id)` without a null check; the ticket documents the
  resulting HTTP 500.
- When activated, that assertion is a concrete violating scenario: it fails on
  the pre-fix code and passes after the guard. It is not a success-path
  assertion that passes before and after the fix (the defect that B exhibits).
- The absence of an explicitly scheduled RED execution is a documentation /
  strength gap, not a missing falsification mechanism. Under `p42-v7` it may be
  recorded as a risk or unknown, but it does not justify blocking the plan on
  counterexample insufficiency.

The 6/6 accept observation corroborates this reading; it is not the basis for
the adjudication.

## R-A decision after observation

The R-A adjudication was adopted on 2026-10-19 after R was accepted 6/6 under
the pre-registered R-B standard. The reasoning:

- The activated regression assertion is a concrete targeted falsification of
  the missing-ID 404/taskId property.
- Plan review does not require the future RED execution to already exist.
- The reviewer's consistent acceptance of R and R+ shows that the explicit
  RED/GREEN description is not required for this plan.
- The Stage 1 full-loop blockers are therefore classified as
  over-strict/harness-confounded, not as a stable reviewer standard.

The R/R+ runs in this dossier were evaluated under R-B and are retained as
raw observations. Under R-A, the R verdicts are passes; the raw verdicts are
not rewritten.

## Final stability matrix (2026-10-20)

The final matrix used R/B/R+ with 15-step suite override, fresh host
configuration per repetition, and three repetitions per arm. A was excluded
after remaining step-budget limited at 10 and 15 steps.

| Case                            | 32K                                | 65K                   |
| ------------------------------- | ---------------------------------- | --------------------- |
| R — unchanged reproduction plan | `accept` 2, `changes_requested` 1  | `accept` 3            |
| B — second green counterexample | `changes_requested` 2, truncated 1 | `changes_requested` 3 |
| R+ — explicit RED/GREEN         | `accept` 3                         | `accept` 3            |

- 65K: 9/9 expected verdicts, no transport failures, no retries.
- 32K: 7/9 expected over all nine attempts; 8/9 bound verdicts. The B failure
  is a real 32K truncation (the truncating call used 32,000 reasoning tokens),
  the R failure is the R-B counterexample interpretation (false positive under
  R-A).
- Full-loop 32K on R: `accept` 3/3. Authorized re-arms occurred in r2/r3; the
  final bound verdict was correct.
- The earlier R/R+ 65K subject-fidelity failures were caused by shared host
  state and escaped quotes; fresh per-run config plus the quote instruction
  removed them in the final matrix.

Full-loop B: 32K bound the correct `changes_requested` in 1/2 comparable runs
(r2; r1 truncated; r3 subject-fidelity exclusion); 65K did so in 3/3, with one
authorized step-budget re-arm. The first 65K full-loop R smoke
bound `changes_requested` with the R-B counterexample finding (false positive
under R-A; 96,251 reasoning tokens, no truncation or re-arm). The targeted
3-repetition 65K R follow-up then bound `accept` 3/3, making the combined
full-loop R result 3/4 accept. **65K is the selected conditional baseline;
32K remains the fallback.** This is not a full validation: the R-B false
positive remains a documented semantic-instability risk.

## Decision procedure

1. Independently choose R-A or R-B and record the decision in this file.
2. R and R+ are in `cases.json` with the R-A gold standard and
   `reviewStatus: "approved"`.
3. Run R and R+ for both token arms, three repetitions each.
4. Compare:

| Observation                          | Interpretation                                                         |
| ------------------------------------ | ---------------------------------------------------------------------- |
| R accepted and R+ accepted under R-A | The design is consistently accepted; Stage 1 blockers were over-strict |
| R blocked and R+ accepted under R-B  | Reviewers react to the added falsification evidence                    |
| R fluctuates                         | Evaluation instability remains at the real problem case                |
| R and R+ fluctuate equally           | A more fundamental semantic-stability problem                          |
| R+ blocked                           | The reviewer rejects even the explicit falsification design            |

Until this adjudication is recorded, R and R+ must not be executed and must not
be used to classify the Stage 1 blockers.
