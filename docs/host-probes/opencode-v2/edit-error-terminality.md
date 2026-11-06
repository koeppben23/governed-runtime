# Pinned native edit-error completion

Finding 7 implementation for re-review, PR #1190, 2026-11-02. This is a bounded
local `edit` failure contract, **not** operator-source acceptance, reviewer
quiescence, general descendant termination or supported ACTIVE V2 cutover.
Findings 5/6 remain blocked; PR #1190 stays Draft / **ACTIVE V2 NO-GO**.

## Source and installed-host evidence

Inspected upstream `v2.2.4` at
[`45898d0f8569225eb1ddb4ee13f8581b34dff311`](https://github.com/anomalyco/opencode/tree/45898d0f8569225eb1ddb4ee13f8581b34dff311):

- `packages/core/src/tool/runtime.ts:29–44`: local typed tool execution failures
  are normalized to `Tool.Error`; interrupts are explicitly not converted.
- `packages/core/src/tool.ts:137–156`: a regular typed failure goes through the
  error-valued `execute.after` hook before returning the failure to the runner.
- `packages/core/src/session/runner/step.ts:125–136`: the local execution fiber
  catches `Tool.Error` and settles it through `publisher.failTool()`.
  `session/to-session-error.ts:75–80` preserves the typed error or gives a regular
  execution failure the `tool.execution` type.
- `session/runner/publish-llm-event.ts:370–385` publishes the exact assistant
  message/call's failed state. `session/message-updater.ts:363–379` copies its
  error and completion time into the owned native tool part.
- In contrast, `session/runner/step.ts:210–228` marks cancellation/interruption as
  `aborted`. `session/runner/llm.ts:420–440` uses `aborted` when settling orphaned
  calls after restart. A completed timestamp alone therefore proves neither a
  regular failure nor safe recovery.
- The AI-layer `tool-error` producer in `packages/ai/src/tool-runtime.ts:23–41,74–96`
  also waits for dispatch/decode/execution settlement before emitting its error
  result; the native error type is not an echoed model-origin field.

The unmodified installed CLI 2.2.4, with client/plugin 2.2.4, demonstrates an actual
throwing edit (`oldString` absent), exact native hook/event/history correlation,
`state.error.type: "tool.execution"`, `executed: false` and native
created/ran/completed times. The interrupted native wait-tool negative instead
records `aborted`. **`executed` means provider-executed in this host contract**;
false is not a claim that the local tool never ran.

## Admitted observation

`integration/host-mutation-observation.ts` admits only one exact current native
session/message/call tuple for an unresolved authorized `edit` episode:

- An exact readable native history contains one owning assistant message and one
  matching tool part. Duplicate, missing and malformed matches are not evidence.
- The part is a local (`executed: false`) edit error with the normative
  `tool.execution` error type and valid input/times. Completion follows the
  recorded authorization; created ≤ ran ≤ completed.
- Raw historical IDs, noncanonical tuples, foreign sessions/messages, hosted
  execution, running/success states, missing times, interrupted/unknown errors,
  event payloads and caller metadata cannot supply this observation.

The adapter's exact current-ID reader uses `nativeHostCallId()` to verify the
stored representation without normalizing or rewriting it. Reconciliation queries
the native session in that persisted identity, including delegated children, while
the existing root-owned completion writer persists the outcome. It does not read
root history as if it were child history. Histories are shared only within the
same native-session reconciliation pass.

`commitMutationCompletion()` remains the sole writer, with its unchanged session,
worktree, fingerprint, dispatch and runtime-lease rechecks and atomic audit outbox.
Concurrent event/barrier observations cannot double-complete or double-audit.
Historical raw IDs remain unresolved and retain the accepted exact-value fenced
manual recovery path. Observed failure does **not** prove unchanged filesystem
bytes; `/implement` must still capture and validate the actual worktree.

## Reload identity defect and correction

The real reload positive exposed a second failure after typed-error observation
was connected: a re-evaluated bundle minted a new module-local RuntimeInstanceId
inside the same live host process. The unchanged lease correctly rejected that
different live holder, leaving the episode unresolved.

`integration/runtime-instance.ts` now keeps its process-lifetime identity on the
shared JS global symbol registry rather than in each evaluated module copy.
Actual native plugin reload and a module re-evaluation regression verify
continuity; neither creates a new lease generation or authorizes unknown-outcome
recovery. This is runtime identity, not a signing key or operator credential.
Distinct live holders are still blocked, and takeover still requires a provably
dead holder and a later generation. No lease timeout, PID-liveness rule or fencing
authority was weakened.
Existing live-holder epochs are not relabelled to the new identity; an older
different live holder remains blocked and requires the existing real-restart/
fenced recovery rather than a compatibility rewrite.

## Actual product-hook positives and limits

`src/cli/opencode-mutation-lifecycle-live.smoke.test.ts` retains the two required
regular-error recovery titles and positive assertions. Its native helper now
explicitly supplies the same **component-only** activation fixture used by the
accepted scope tests: direct workflow-state setup alone no longer activates the
product. That test RPC is never installed or distributed as product authority.
These are real host/product-hook recovery positives, not StartGovernance/UI
acceptance or a complete installed user workflow.

- Event path: actual native edit throws; fresh host history closes the authorized
  episode as failure; `/implement` records the current changed file.
- Reload barrier: a labeled fixture deliberately drops both product completion
  callback and failed-event delivery while retaining the actual host's execution
  and history. The test asserts both drops occurred, reloads the real plugin,
  verifies the episode remains unresolved and status stays blocked, then proves
  `/implement` re-reads the native failure and recovers without an unknown-outcome
  resolution. No fabricated terminal result or fake dead PID is supplied.
- Delegated child: a real ordinary native subagent executes the failing edit. Its
  exact native identity closes one episode in the root state; the parent then
  records the actual worktree. This ordinary delegation creates no reviewer proof.

Reproduction:

```sh
npm run build
OPENCODE_LIVE=1 npx vitest run --project smoke src/cli/opencode-mutation-lifecycle-live.smoke.test.ts
```

The focused installed-host run passed **8 tests / 0 skips**. The earlier run
failed the reload positive on the live-holder lease error; it was not waived.
Full regression, mutation and CI results must be reported against their exact
final source/test snapshots; this focused result does not imply a green whole PR.

## Final local verification (2026-11-02)

- `npm test`: **701 files / 12,806 passed / 2 existing skips**.
- `npm run test:coverage:ci`: **701 files / 12,797 passed / 11 configured skips**.
  This local instrumented pass does not diagnose the separately open GitHub
  production-graph timeout. Its unchanged 15-second limit and selection remain.
- Full native smoke with `OPENCODE_LIVE=1 RUN_OPENCODE_ACP_TESTS=1`:
  **117 passed / 4 failed / 0 skips**. All three MUT4 product-hook positives pass;
  the four retained reviewer/capture/recovery tests still fail. The unchanged
  independent-review verifier fails on those same four required contracts.
- Typecheck, strict lint, architecture (**538 tests**), build/doc drift and unused
  dependencies pass. These are local checks, not exact-head GitHub certification.
- Final bounded mutation: **98.90%**, unchanged 80% gate; **88 assertion kills /
  2 timeouts / 1 survivor / 0 no coverage**, with **61 compile-invalid** mutants
  and **45 ignored by the unchanged base configuration** separately recorded.
  Scope: the native edit observer, reconciliation, runtime identity and the new
  exact-ID reader (adapter lines 220–239). The sole survivor removes the empty-
  episode early return; the subsequent empty loop performs no host read/write.
  Runtime identity has no scorable mutants (all four generated mutants fail
  compilation), not an asserted 100% behavioral mutation score. Its actual reload
  and module re-evaluation positives are separate evidence.

The final mutation selection includes the new runtime-identity covering suite;
production and all four covering-test snapshots match the final working bytes.
The earlier report without that added suite is not its evidence. Final report
SHA-256: `8924e367976fd132ea2fd579ff3f0d129360df81c010f0dd73be37adc3ae508f`.
This is not a full-repository/profile mutation admission. No reviewer verifier,
test exclusion, evidence generation or coverage/mutation threshold was weakened.
