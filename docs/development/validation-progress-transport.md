# Validation Progress: Transport Probe

## Scope and decision

**Transport probes plus a targeted lifecycle repair. The full progress-feature
gate is BLOCKED, not passed.**

The candidate-host probe establishes some transport mechanics. A follow-up
product regression reproduces and repairs its lifecycle finding. Neither
implements the product progress UI nor instruments the executor. State schemas,
audit contracts, reviewer admission and retry/backoff persistence remain unchanged.

Reference source: `develop` at `41b2932e32fc84b64af435486c0ecfa3ad837c15`.
Local execution: 11 November 2026, macOS arm64, Node 22.22.2 / npm 10.9.7,
exact native CLI candidate `@opencode/cli@2.2.5`. The repository API dependencies
remain `@opencode/plugin` / `@opencode/client` 2.2.7. The independently declared
CLI candidate remains owned by `.sdk-baselines/opencode/cli-candidate.json`.

## Executable evidence

`src/cli/opencode-validation-progress.smoke.test.ts` runs against a private
native host, deterministic local model-wire provider and real POSIX TUI/PTY.
The companion `opencode-validation-progress-test-helpers.ts` defines a local
test plugin, a held Promise and a read-only snapshot RPC. Its phase labels are
fixture labels, not evidence that FlowGuard entered either validation phase.

The fixture does not load the FlowGuard product plugin or execute a build. Its
`runID` is an ephemeral transport correlation ID, **not a ValidationAttempt**.
It never emits `PASS`. Releasing the Promise proves fixture completion only.

| Route                                       | Observation                                                                                                                                                                        | What remains unproved                                                                           |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Native tool                                 | `ToolContext.progress()` reaches the actual `session.tool.progress` stream while the native tool remains running; one user prompt and no extra model call during the held interval | Native tool progress rendering; actual `flowguard_*` validation wiring                          |
| Native command, both phase labels           | A session-location-scoped snapshot is read and visibly rendered by the test TUI as a toast before command completion; zero user messages/model calls                               | Production `/approve`, automatic plan approval and `/implement` wiring; durable attempt binding |
| Consumer disappears                         | The fixture command completes after the TUI process is closed and the barrier is released                                                                                          | Production bounded delivery, hung receiver handling and cleanup under all failure modes         |
| Ordinary execution success / product resume | The separate product-host regression resumes persisted validation after an admitted `session.execution.succeeded`, executing only open checks in both validation phases            | Resume progress display and packed-product acceptance                                           |

The transport suite has three positive fixture cases. The separate product-host
case covers both validation phases. Four passing cases are still **not** full
progress-feature acceptance.

### Lifecycle counterexample and bounded repair

The probe originally required a snapshot after ordinary foreground success
through the existing `session.idle` route. That expectation failed. The captured
native stream contained `session.execution.succeeded` instead, and the armed
idle observer did not run.

The original negative characterization at `8359a511` passed the captured event
through the product projector and established that it returned `null`. It is
now replaced by `src/cli/opencode-validation-resume.smoke.test.ts`: before the
repair, this real product-path regression persisted a technical interruption
but stayed in `VALIDATION` after ordinary native success.

The new case loads the actual product plugin, runs native `/start` and `/approve`,
and later records an implementation through the native tool. **Only the core
plan-review gate and active check selection are explicit component fixtures**;
this is not independent reviewer/operator provenance or packed-install acceptance.
Discovery supplies the commands. Real subprocesses produce a controlled exit
127, persisted subject-bound `ValidationAttempt`s and a re-armed
`pendingSystemWork` marker. The fixture waits for the persisted backoff rather
than rewriting it. In both `VALIDATION` and `IMPL_VALIDATION`, ordinary native
completion then reruns only the open check, preserves the earlier bound PASS,
clears the marker and advances through the canonical check-result path.

Success is **not an alias for idle**. The projector preserves its event type and
creation time. ACTIVE root-scope admission precedes a native adapter claim:

- aggregate identity must match the event session;
- a per-session sequence high-water mark rejects concurrent/replayed delivery;
- a fresh exact-session read must report `outcome: succeeded`, `time.idle` equal
  to the notification's `created`, and `time.busy <= time.idle`. Old idle/outcome
  values while a later execution runs do not suffice;
- the canonical runner checks both notification creation time and current time
  against persisted backoff. Delayed delivery cannot make an inside-backoff
  notification eligible. Existing generation fencing and in-flight guards remain.

The pinned candidate supplies matching native completion/session timestamps in
the live regression; the test observes no `session.idle` through those completions.
Integration tests cover duplicate/out-of-order notifications, stale/running or
non-successful session state, identity/read failures, unrelated and delegated
scope exclusion, and delayed delivery within backoff. Delegated-scope testing
uses an explicit scoped-port fixture, not native delegation provenance.
Notifications never supply check-result or reviewer evidence. No timer-driven
retry or process-quiescence guarantee is added.

### Snapshot location is not an arbitrary UI location

An initial RPC reader used the TUI plugin location. On macOS, `/var/...` and
`/private/var/...` selected distinct host plugin instances, despite referring
to the same files. The command's instance held the snapshot; the reader's
instance returned `null`. Captured setup/read records exposed the mismatch.

The probe reader now uses the selected host session's `location`, obtained
from the existing TUI session cache. It rechecks the current session after the
RPC resolves and performs no filesystem-based alias migration or fallback.
The final assertions require actual terminal output, not merely a successful
RPC response or the fixture's observation file.

The TUI context's location can also be absent during setup. Diagnostic output
uses the known fixture path; RPC routing never guesses from that path.

## Reproduce

Use the pinned repository Node toolchain and either install the exact declared
candidate or set `OPENCODE_CLI` to its executable. An explicit mismatching
binary fails in the existing host helper; there is no historical-host fallback.

```bash
OPENCODE_LIVE=1 npm run test:smoke -- --no-file-parallelism \
  src/cli/opencode-validation-progress.smoke.test.ts
OPENCODE_LIVE=1 npm run test:smoke -- \
  src/cli/opencode-validation-resume.smoke.test.ts
```

Optionally set `FLOWGUARD_PROGRESS_PROBE_REPORT_DIR` to an owned evidence
directory. Before fixture cleanup, each case saves the exact host version,
native observations, provider-request session IDs, UI observations and bounded
terminal capture there. These are test traces, not persisted product progress
state or audit evidence. The suite's JSON reporter can be retained separately.

The existing CI smoke job enables `FLOWGUARD_OPENCODE_HOST_E2E=1`, installs and
checks the exact candidate, and discovers this suite without a workflow change.
The two PTY-dependent cases are explicitly skipped on Windows. A run without
either live-host flag skips the suite and is **not transport evidence**.

## Product implementation remains gated

The supported native success route now has product-path evidence. Before claiming
the complete feature, independently verify the required UI scope. The product implementation must:

- replace, not supplement, the current `presentValidationProgress()` prompt;
- cover explicit/automatic plan approval, `/implement` and supported resume;
- observe a confirmed shell `spawn` before claiming process start, without
  changing executor output/digest/error semantics;
- use the existing `ValidationAttempt.attemptId` and baseline/implementation
  subject identity; allocation alone is not persistence;
- publish a final check result only after classification, attestation and
  successful persistence through the existing run-check authority;
- isolate and bound display delivery so a failed or hanging consumer cannot
  alter validation or hold a session write lock;
- reject stale attempt/subject updates and distinguish unknown display state
  from actual running or completed work.

**NOT_VERIFIED:** installed packed-product progress, Desktop rendering,
Windows rendering, real-provider acceptance, native tool rendering,
ValidationAttempt-bound result projection, confirmed subprocess-start
instrumentation, reload/stale-update behavior and a hanging consumer.
Recovery requires the corresponding installed-host/UI and product negative
tests; rerunning this fixture alone cannot establish those claims.

No new state schema, second executor, PASS/FAIL authority, console streaming,
or fix for process quiescence [#1173](https://github.com/koeppben23/governed-runtime/issues/1173)
is introduced. This is not a new V2 migration or full host-certification claim.
