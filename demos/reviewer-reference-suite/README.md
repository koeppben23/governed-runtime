# Reviewer Reference Suite

This directory defines a fixed, versioned reference suite for the independent
ProofGraph reviewer. It separates **termination stability** from **evaluation
stability** and keeps the review criteria, model, frozen subject, evidence, and
governance gates unchanged.

The suite does not try to make the reviewer return `accept` more often. It asks
whether the reviewer applies the same professional standard to the same frozen
evidence and finishes the review it started.

## Assurance boundary

- Deterministic contract tests in
  `src/documentation/__tests__/reviewer-reference-suite.test.ts` verify fixture
  consistency, schema validity, references, and the internal coherence of the
  gold standard.
- They do **not** prove that a reviewer will apply a semantic rule correctly.
  That requires a recorded live run against the frozen subject and evidence.
- Every case keeps `behaviorStatus: "NOT_VERIFIED"` until a later live run is
  checked against it.
- The gold standard is independently authored and versioned. It is never
  derived from model answers.
- A successful `finish: "stop"` is necessary but never sufficient. A review is
  successful only when the verdict, required findings, forbidden findings,
  evidence bindings, and consistency all match the gold standard.

## Files

| File                                | Purpose                                                                                                                           |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `cases.json`                        | Frozen subjects, offered evidence, and independently authored gold standards for 10 plan-review and 5 implementation-review cases |
| `reproduction/2026-10-19-plan.json` | The frozen plan from the 2026-10-19 GUI truncation; a termination-reproduction subject, not a gold-standard verdict               |
| `run-record.example.json`           | Example of the per-run record schema                                                                                              |
| `observe-chat-params.mjs`           | Test-only OpenCode plugin that records prepared `chat.params`; never installed as a product plugin                                |
| `run-live.mjs`                      | Real FlowGuard/OpenCode plan-review runner and run-record writer                                                                  |

## Gold-standard types

### `plan_review`

Plan review precedes baseline and implementation validation. It assesses
whether the plan is complete, correct, feasible, and has a targeted
falsification mechanism. It must not require executed results that cannot exist
yet.

Plan-review cases do **not** declare formal ProofGraph claim states. A plan can
object to an insufficient evidence route without computing the later
`NOT_VERIFIED` claim state.

### `implementation_review`

Implementation review assesses executed, digest- and attempt-bound evidence on
the current revision. It may additionally declare `expectedProofGraphStates`,
but those formal states are separate from the reviewer verdict.

## Cases

Plan review:

- A: correct plan with a targeted, executable falsification design → `accept`
- B: counterexample is a second green run without a faulty variant →
  `changes_requested`
- R: the unchanged reproduction plan uses the activated regression assertion
  as a targeted falsification → `accept` (R-A)
- R+: the reproduction plan with an explicit RED/GREEN design → `accept` (R-A)
- C1: the plan's stated verification route uses a candidate that is absent from
  the offered candidates → `changes_requested`
- C2: the plan's stated check command is not executable → `changes_requested`
- C3: checks are correctly planned for a later validation phase → `accept`
- C4: cited evidence is not traceable in the frozen revision →
  `changes_requested`, without inventing a different defect
- D: plan violates the approved ticket contract → `changes_requested`
- E: style-only note → `accept`, non-blocking only

Implementation review:

- IA: executed positive and adversarial evidence → `accept`, `PROVEN`
- IB: second green execution as counterexample → `changes_requested`,
  `NOT_VERIFIED`
- IC: executed evidence is missing → `changes_requested`, `NOT_VERIFIED`
- ID: implementation violates the approved contract → `changes_requested`,
  `CONTRADICTED`
- IE: style-only note → `accept`, `PROVEN`

C1 and C2 require a synthetic Discovery fixture and are not executed by the
initial live runner. Implementation-review cases are defined now and are
executed only in the later full-matrix stage.

## R/R+ adjudication (R-A)

The 2026-10-19 reproduction plan is the real problem case. The independent
adjudication selected **R-A** after the pre-registered R-B standard failed:

- **R** (`plan-r-reproduction-plan`) — the unchanged reproduction plan; expected
  `accept`.
- **R+** (`plan-r-plus-explicit-red-green`) — the same plan with an explicit
  RED/GREEN falsification design; expected `accept`.

The frozen evidence, the exact plan excerpts, the adjudication record, and the
decision procedure are in
[`adjudication/r-and-r-plus.md`](./adjudication/r-and-r-plus.md). Both cases are
now in `cases.json` with `reviewStatus: "approved"`.

## Two ground-truth layers

1. **Deterministically checked:** schema, IDs, referenced files, frozen
   revision, internal consistency, and — where executable — that a deliberately
   faulty variant actually fails the bound check and a second green run actually
   passes.
2. **Independently authored and approved:** the expected reviewer judgment with
   rationale, contract references, and evidence references. This is the gold
   standard the live run is compared against.

Changing a case or its gold standard changes the corpus digest. Runs from
different corpus digests are not comparable.

## Token comparison

The only experimental variable is the OpenCode output-token cap. In OpenCode
v1.19.3, `ProviderTransform.maxOutputTokens` computes:

```text
min(model.limit.output, OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX)
```

The default cap is 32,000. Model/provider configuration must stay identical in
both arms; do **not** change `provider.<id>.models.<model>.limit.output` to try
to raise the cap.

| Arm | Host environment                               |
| --- | ---------------------------------------------- |
| A   | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=32000` |
| B   | `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536` |

Hard preconditions:

- The actual host model catalog must report `model.limit.output >= 65536`.
- The variable must be set in the real OpenCode host process.
- The review message must use the selected variant `max`.
- The installed reviewer agent must use `reasoningEffort: none`, the supported
  OpenCode structured-review transport.
- The resolved provider reasoning options must be identical in both arms.
- Invalid values (`0`, negative, non-integer) are rejected before launch because
  OpenCode falls back to the 32,000 default.

The runner does **not** pin a `model:` in the reviewer agent frontmatter. It
installs the OpenCode default `FLOWGUARD_REVIEWER_EFFORT=none`, passes the parent
model via `--model`, and selects `--variant max` for the review turn. The Task
transport then inherits the parent model and variant for the review call while
the same-child follow-up uses the agent's non-thinking serialization mode. This
reproduces the original two-call transport:

| Call                            | Purpose                                | Reasoning     |
| ------------------------------- | -------------------------------------- | ------------- |
| Review message                  | independent falsification-first review | variant `max` |
| Same-child structured follow-up | serialize the concluded findings       | `none`        |

The runner records the installed frontmatter (`reviewerModel`, `reviewerEffort`),
the prepared params of every observed model call, and the review-vs-serialization
reasoning tokens from the child transcript. The variant name `max` is not assumed
to be a literal `reasoningEffort: "max"` in the follow-up; the invariant is that
the two phases keep their supported modes in both arms and only the output cap
differs.

The same variable also affects compaction reservation (`session/overflow.ts`).
Record compaction/overflow events as part of the intervention.

## Instrumentation: separate layers

| Layer                  | Tool                            | What it proves                                                                      |
| ---------------------- | ------------------------------- | ----------------------------------------------------------------------------------- |
| Selected variant       | `chat.message` observation hook | the OpenCode variant exposed for the child request, when the host provides it       |
| Prepared host params   | `chat.params` observation hook  | model limit, prepared `maxOutputTokens`, reasoning options                          |
| Final provider request | Capture-provider smoke test     | the actual `max_tokens` / `max_output_tokens` sent to the provider                  |
| Provider behavior      | real DeepSeek run               | whether the provider accepts the request and actually emits more than 32,000 tokens |

`chat.params` is mutable and is **not** proof of the final provider request. A
successful capture test is not proof that the provider can emit more than
32,000 tokens; only an observed run can establish that.

## Current A/B signal

The clean single-review signal (one repetition per arm, after the fixture
correction) is:

| Case                            | 32K                 | 65K                 |
| ------------------------------- | ------------------- | ------------------- |
| A — targeted falsification      | `accept`            | `accept`            |
| B — second green counterexample | `changes_requested` | `changes_requested` |

All four runs completed, serialized with `reasoning: none`, and matched their
gold standard. This is a signal, not a three-repetition stability measurement.
The B findings include the intended counterexample-sufficiency finding; the
plans were tightened to use the exact candidate commands so the command wording
does not become an unintended confounder.

## Stability matrix results (2026-10-20)

The final matrix used the R/B/R+ cases, 15 steps for the isolated reviewer,
fresh host configuration per repetition, and three repetitions per arm. A was
excluded after remaining step-budget limited at 10 and 15 steps.

| Case                            | 32K                                                    | 65K                   |
| ------------------------------- | ------------------------------------------------------ | --------------------- |
| R — unchanged reproduction plan | `accept` 2, `changes_requested` 1 (R-B false positive) | `accept` 3            |
| B — second green counterexample | `changes_requested` 2, truncated 1                     | `changes_requested` 3 |
| R+ — explicit RED/GREEN         | `accept` 3                                             | `accept` 3            |

- 65K: 9/9 expected verdicts, 0 transport failures, 0 retries.
- 32K: **7/9 expected verdicts over all nine attempts**; 8/9 bound verdicts. One B run truncated without a verdict; one R run was a R-B false positive under R-A.
- The full-loop 32K baseline on R bound `accept` 3/3. Authorized truncation and
  step-budget re-arms occurred in r2/r3, but the final decision bound correctly.
- **Full-loop B comparison:** 32K bound the correct `changes_requested` in 1/2
  comparable runs (r2; r1 truncated; r3 is the subject-fidelity/parent-revision
  exclusion); 65K bound it 3/3, with one authorized step-budget re-arm. The 32K
  truncating call used exactly 32,000 reasoning tokens and returned
  `finish: length`.
- **Full-loop R 65K smoke:** one `accept`-expected run bound
  `changes_requested` with the R-B counterexample finding (R-A false positive):
  96,251 reasoning tokens, no truncation, no re-arm. The targeted 3-repetition
  follow-up then bound `accept` 3/3 (no truncations), so the combined 65K
  full-loop R result is 3/4 accept. The positive 3-rep result satisfies the
  switch precondition; the isolated R-B false positive remains a documented
  semantic-instability risk.
- The two 32K failures are separated: the B failure is a token-limit
  termination failure; the R failure is the R-B counterexample interpretation,
  a false positive under the R-A adjudication.
- Full raw records and hashes are in
  [`matrix-results-2026-10-20.json`](./matrix-results-2026-10-20.json).

The 65K configuration is the more stable single-review configuration and the
more reliable full-loop B configuration. The targeted 65K R full-loop run bound
`accept` 3/3, satisfying the switch precondition. **65K is the productive
reviewer output cap; 32K remains the fallback.** The residual R-B false positive
and the 32K B truncation are documented risks, not reasons to keep 32K as the
default.

The effective host setting is `OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX=65536`
(OpenCode host process, not a `flowguard.json` field). It applies to the whole
host process, not only the reviewer; monitor reasoning tokens, truncations,
re-arms, and runtime.

## Staged execution

| Stage | Content                                                         | Runs                      |
| ----- | --------------------------------------------------------------- | ------------------------- |
| 0     | Suite, gold standard, contract tests, instrumentation           | 0                         |
| 0.5   | Transport smoke: reasoning review + non-reasoning serialization | 1                         |
| 1     | Reproduction plan 2026-10-19, 32K vs 65K                        | 2 arms × 3 = 6            |
| 2     | Cases A and B, both arms                                        | 2 cases × 2 arms × 3 = 12 |
| 3     | Full matrix, only after Stage 1/2 show a signal                 | 13 × 2 × 3 = 78           |
| 4     | Decision and, if needed, suite expansion                        | —                         |

Stage 0.5 must pass before Stage 1: the main review must use reasoning, the
same-child serialization must use no reasoning, and the structured findings must
bind successfully. Stage 1 measures termination only. Stage 2 measures
termination and evaluation. Do not start Stage 3 before Stage 1 shows a
termination improvement and Stage 2 shows stable, gold-standard-conforming
evaluation.

## Running

Run the runner under the repository's pinned Node/npm toolchain (`.node-version`
and `package.json#engines.npm`). Install the requested host and put it first on
`PATH`:

```sh
OPENCODE_CLI_VERSION=1.19.3
npm install --prefix /tmp/fg-opencode-1.19.3 \
  --no-audit --no-fund "opencode-ai@$OPENCODE_CLI_VERSION"
export PATH="/tmp/fg-opencode-1.19.3/node_modules/.bin:$PATH"
opencode --version   # must print the requested version
```

Validate the selection without a live run:

```sh
node demos/reviewer-reference-suite/run-live.mjs \
  --root /tmp/fg-review-suite-check \
  --case plan-a-targeted-falsification \
  --check
```

Run the transport smoke first (one review at 32K):

```sh
node demos/reviewer-reference-suite/run-live.mjs \
  --root /tmp/fg-review-suite-transport \
  --tarball ./flowguard-core-2.0.0-tp.2.tgz \
  --case reproduction-2026-10-19-plan \
  --transport-smoke
```

Prove the host applies the cap to the final request (no provider credentials
needed; uses the local capture server):

```sh
OPENCODE_LIVE=1 \
OPENCODE_CLI=/tmp/fg-opencode-1.19.3/node_modules/.bin/opencode \
OPENCODE_EXPECTED_HOST_VERSION=1.19.3 \
npx vitest run --project smoke src/cli/opencode-output-token-limit.smoke.test.ts
```

Run Stage 1:

```sh
node demos/reviewer-reference-suite/run-live.mjs \
  --root /tmp/fg-review-suite-stage1 \
  --tarball ./flowguard-core-2.0.0-tp.2.tgz \
  --case reproduction-2026-10-19-plan \
  --arm 32000 \
  --repetitions 3
```

Then repeat with `--arm 65536` and a fresh root. Stage 2 uses the same command
with `--case plan-a-targeted-falsification` and
`--case plan-b-second-green-counterexample`.

The runner writes one `*.record.json` per run and an aggregate
`evidence/run-records.json`, plus `evidence/chat-params.jsonl` and the exported
host transcripts. The runner does not converge a plan revision loop: a
`changes_requested` verdict is a measurement result, not a request to author a
new plan.

## Decision

| Result                 | Meaning                                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `validated`            | termination and evaluation meet all criteria; 65K may be used productively                                                            |
| `conditional_baseline` | termination improved, evaluation has a documented residual risk; approved for production with monitoring, not a statistical guarantee |
| `experimental_only`    | termination improved, evaluation unstable → `NOT_VERIFIED` for productive use; 65K remains an experiment                              |
| `rejected`             | 65K unsupported or no termination improvement                                                                                         |
| `inconclusive`         | configuration, host version, or provenance not comparable                                                                             |

An improvement in termination alone is never a successful validation. The 65K
decision is `conditional_baseline`: approved for production with monitoring, not
a full validation. If the residual evaluation instability grows or cannot be
monitored, the configuration returns to `experimental_only` (`NOT_VERIFIED`).
