# Validation Progress: Transport Probe

## Scope and decision

**Transport probes plus a targeted lifecycle repair. The full progress-feature
gate is BLOCKED, not passed.**

The candidate-host probe establishes some transport mechanics. A follow-up
product regression reproduces and repairs its lifecycle finding. A later repair
replaces model-visible status prompts with a bounded, model-free presentation
channel. This is **not** the complete product progress UI: installed UI
acceptance, attempt-bound result projection and executor-start instrumentation
remain gated. State schemas, audit contracts, reviewer admission and
retry/backoff persistence remain unchanged.

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

### Completed-review event ownership and audit replay

A subsequent incident ran OpenCode **2.2.7**, with the earlier lifecycle repair
installed. Its independent reviewer successfully returned `changes_requested`;
that verdict was not a build failure. Four location instances shared plugin
storage and the server-wide event stream. Completed-child success handling
could re-enter execution-specific reviewer admission, which correctly rejects a
finished dispatch, and then fence the parent. The original incident's first
exception is absent from the inspected logs; the new native regression exposes
the admission errors directly. Repeated delivery of one failure notification
also produced separate audit UUIDs.

`opencode-reviewer-event-lifecycle.smoke.test.ts` now drives native Start,
ticket, plan and independent reviewer return across four locations, without
seeded review evidence. It asserts the captured `changes_requested`, fulfilled
obligation, successful parent continuation and unchanged PLAN phase. On
12 November 2026 it passes with both candidate **2.2.5** and the exact incident
**2.2.7** binary, using a deterministic local provider. This is not installed
packed-product, Desktop UI or real-provider certification.

The adapter compares the exact native session `location.directory` to its
plugin location before governance execution admission. No filesystem alias or
workspace inference substitutes for this identity. Idle/success notifications
from children are excluded before reviewer admission; genuine owning-scope
read/handler errors still fence. Deletion cleans only previously cached session
metadata, without looking up an already deleted native session.

Session-error audit IDs derive from the FlowGuard session and native event ID.
The existing canonical audit lock serializes trail lookup and append. A replay
uses the first committed phase and native creation time; the canonical writer
still rejects changed immutable notification content. Missing identity/time or
failed persistence cannot silently create fallback identities or mark success.
No audit schema, reviewer guard, validation authority or retry policy changes.
The event fence still reports its original exception through the host console;
this repair does not add a durable host-log collector or repair incident data.

The private native helper waits boundedly for required plugin registration:
2.2.7 can initially expose an empty registry before registration. Explicitly
failed/inactive plugins and transport errors are never hidden by that wait.

### Model-free status presentation (12 November 2026)

A follow-up forensic report found `/approve` apparently shown again after a
successful decision. The reported debug export showed two additional `user`
messages and two independent model responses with no tool call. The
repository's earlier native smoke log independently corroborates the mechanism:
the validation and decision status texts appeared verbatim as `type: "user"`
in the provider request and produced model turns.

`ctx.session.prompt()` is an inbox admission, not a UI status API. The previous
`presentValidationProgress()` and `presentDecision()` calls therefore created a
new user turn merely to display text. The same pattern existed in the Start,
End/RecoverCapacity, diagnostics and debug-export status paths.

The repair introduces a separate, explicitly non-authoritative presentation
channel:

- `plugin-presentation.ts` keeps a bounded in-memory page per session. It has no
  durable storage, is never appended to the audit trail and is never model
  context. A bounded message/event count prevents unbounded host memory use.
- `GetPresentation` is a read-only RPC. It verifies the requested session's
  exact native location, returns an empty page for an unavailable or foreign
  session, and never fences a scope. The UI falls back to canonical
  `GetNextAction`/status. The server never awaits a UI reader.
- The validation runner reports `starting`, `check_started` and
  `check_finished` presentation events. The callback is invoked without awaiting
  it; a throwing or never-settling presentation callback cannot delay checks,
  hold a lock or change a result.
- Decision, Start, lifecycle, diagnostics and debug-export text is recorded as a
  notice, validation event or report. `/check` and reviewer orchestration remain
  intentional model prompts because they request agent work.
- The TUI plugin polls the presentation page only for its current session,
  deduplicates event IDs, announces the newest baseline event and adds a
  `/flowguard-report` dialog for the latest report. The Desktop ComposerPill
  polls only while mounted and visible, shows the latest validation/decision
  notice and exposes the latest report in its popover.

The native decision smoke test now asserts that `/approve` creates **zero**
additional provider requests, that no validation/decision status text enters the
session context, and that the read-only RPC contains the validation and decision
events. Unit and integration tests cover store bounds, replay/cursor behavior,
session switching, duplicate suppression, transport failure, a hanging
progress callback, and the absence of `session.prompt`/`session.synthetic` on
the status paths.

**NOT_VERIFIED:** installed packed-product TUI/Desktop visual acceptance,
Windows/real-provider behavior and screen-reader acceptance. The Desktop bundle
is template-tested with host-shaped stubs; that is not installed GUI proof.
Presentation is ephemeral by design, so a reload loses pending notices; the
canonical Next Action projection remains the fallback. Diagnostic report text is
local UI text, not audit evidence or an approval.

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
OPENCODE_LIVE=1 npm run test:smoke -- \
  src/cli/opencode-reviewer-event-lifecycle.smoke.test.ts
OPENCODE_LIVE=1 npm run test:smoke -- \
  src/cli/opencode-decision-command-live.smoke.test.ts
```

The decision-command smoke test asserts that the real `/approve` path creates
no extra provider request or status user message, and that the read-only
presentation RPC contains the validation and decision notices. It uses explicit
component review-gate fixtures; it is not independent reviewer provenance.

For the incident-only regression, set `FLOWGUARD_OPENCODE_INCIDENT_CLI` to the
exact 2.2.7 executable. Its version is checked; this does not alter the canonical
candidate pin or replace the user's CLI. All probes use isolated native storage
and never replay the original affected session.

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

The supported native success route now has product-path evidence. The former
`presentValidationProgress()` and decision-confirmation prompts are replaced by
the model-free presentation channel; they are not supplemented by a prompt
fallback. Before claiming the complete feature, independently verify the
required installed UI scope. The remaining product implementation must:

- prove the presentation channel in the packed TUI and Desktop product, including
  explicit/automatic plan approval, `/implement` and supported resume;
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

**NOT_VERIFIED:** installed packed-product progress, installed TUI/Desktop
presentation, Desktop rendering, Windows rendering, real-provider acceptance,
native tool rendering, ValidationAttempt-bound result projection, confirmed
subprocess-start instrumentation, reload/stale-update behavior and a hanging
consumer. The model-free channel and its failure isolation are tested at the
component and native `/approve` boundary, but that is not installed GUI
acceptance. Recovery requires the corresponding installed-host/UI and product
negative tests; rerunning this fixture alone cannot establish those claims.

No new state schema, second executor, PASS/FAIL authority, console streaming,
or fix for process quiescence [#1173](https://github.com/koeppben23/governed-runtime/issues/1173)
is introduced. This is not a new V2 migration or full host-certification claim.
