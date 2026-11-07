# Desktop 2.2.6 remaining product gates — verification contract

**PR:** #1207 (Draft). **Change under test:** optional GUI status reconciliation
and accessibility semantics, plus native installed lifecycle regression hardening.
**No installed PASS is asserted for the new GUI bundle by this document.**

## Evidence discipline

Pin and record **all** of: Git HEAD, packed tarball SHA-256, installed
`@flowguard/core` build revision, GUI bundle SHA-256, OpenCode binary version,
operating system, host PID and whether the installer ran inside the host. Do
not reuse evidence for a previous GUI hash.

Separate three categories in the report:

- **Source/CI proof:** shape, placement, lifecycle guards and unit/architecture tests.
- **Isolated installed host proof:** a private temporary OpenCode service, with
  customer-sentinel content, running during install/reload/uninstall.
- **User's live Desktop proof:** actual native GUI, VoiceOver, event/reconnect
  behaviour and exact installed bytes. No automatic workflow decisions.

A PASS in one category never upgrades another category to PASS.

## A. Current-session refresh coverage

| Source | Behaviour | What it does **not** prove |
| --- | --- | --- |
| `session.execution.succeeded` | Immediate read-only inspection for the current sidecar session | Every state mutation emits this event |
| 30-second visible-session reconciliation | On a mounted, visible sidecar session, re-read `GetNextAction` and, at an eligible gate, `GetWorkbenchReview` | Real-time latency, host disconnected, hidden windows, automatic updates without any GUI |
| Explicit Refresh and palette | Operator requests a canonical read | A historical/audited snapshot |
| Session switch, stale reply, plugin reload | Identity and generation fencing; previous results must not authorize a decision | A replayable/durable event stream |

The reconciler is created once per plugin GUI root, starts only when a composer
pill is shown, does not call RPC at registration or on the first render, and
is disposed with the GUI owner. It does not poll hidden windows or foreign
servers. At most one inspection is in flight; concurrent events/ticks coalesce
into one follow-up read. These bounds prevent a slow host from accumulating
unbounded requests. Completion events remain useful fast-path hints.

**Truthful scope:** active, visible, connected sessions gain *bounded
best-effort eventual reconciliation*. It is NOT a guarantee for every
transition at a fixed deadline: the host may disconnect, a request may fail,
the renderer may be closed, and live events have no replay. There is no
durable approval notification or audit feed.

Run the installed checks against disposable sessions:

1. Open the Demo and verify **no RPC** on registration and no mutation of
   its messages, activation generation, decisions or audit chain.
2. In a disposable session, complete a host execution and observe
   `session.execution.succeeded` automatically refreshing the pill.
3. Disable only that event hook in an isolated fixture (not production) and
   verify the current visible sidecar reconciles on the timer; no model prompt,
   workflow command, decision, hydrate or audit mutation occurs.
4. Switch the focused session/server and inject a delayed response; it must
   not overwrite the current status. Burst three events while a read is
   unresolved; at most one in-flight and one catch-up query may run.
5. Hide the window, advance the timer and confirm no RPC. Make it visible
   and confirm reconciliation resumes. Dispose/reload and verify timers and
   event handlers are gone.
6. Exercise `READY`, `PLAN`, `PLAN_REVIEW`, `ARCH_REVIEW`,
   `EVIDENCE_REVIEW`, `BLOCKED`, terminal and `NOT_VERIFIED`.
   Capture actual observed transitions; do not claim a phase PASS from
   another phase's screenshot.

**Result:** Code-level adapter and reconciliation tests are supplied; a
fresh installed pass for this new GUI bundle is required.

## B. Accessibility — VoiceOver acceptance

A DOM `role=region`, `aria-label` and `aria-live=polite` are **testable
semantics, not a screenreader acceptance**. Native `button` and
`details/summary` are retained for keyboard interaction.

On macOS with OpenCode Desktop 2.2.6 and the exact new GUI hash:

1. Enable VoiceOver (macOS Accessibility settings, or the system VoiceOver
   shortcut) and navigate by keyboard only. Record macOS/VoiceOver version,
   display scaling and zoom.
2. Locate the composer pill: its accessible name must identify FlowGuard and
   communicate that the state is read-only/last read. Activate
   `Inspect canonical status` and confirm the status is announced.
3. Complete disposable work: the status should update automatically and be
   announced once coherently; make no decision. Check `NOT_VERIFIED`,
   `STALE` and `BLOCKED` as **not approved**.
4. Open the Workbench. VoiceOver must recognize its named region, the phase
   status, all eight expandable sections, their summaries and the native
   Refresh / Expand / Open decision buttons. Opening/closing a section must
   not move focus unexpectedly.
5. Open the canonical chooser in a disposable bound gate, use arrows and
   Escape, and verify no `SubmitDecision`. Confirm that reviewer
   `accept` is explicitly distinguished from operator approval.
6. Repeat at 200% display scaling, light/dark appearance, reduced motion
   enabled and a narrow window; no clipped focus trap or unreadable labels.
7. Record observed spoken strings, focus order, screenshots and the
   fail-closed results. A tester must mark PASS/FAIL/PARTIAL individually.

**Result:** Static accessibility semantics and executable DOM assertions
are present. Independent VoiceOver result remains **NOT_VERIFIED** until
performed on installed Desktop.

## C. Upgrade while the service is running

The CLI supports an external, process-safe restart and a fail-closed
in-service restart guard. An installer invoked **inside** the running service
cannot be treated as a successful zero-restart upgrade merely because files
on disk changed and the GUI hot-reloaded.

Required isolated proof before claiming *zero-restart upgrade*:

1. Boot a private service with a pinned known **revision A** and record its
   exact PID and RPC-visible behaviour (not just on-disk file hashes).
2. From an external process install a distinct pinned **revision B** using
   `--no-restart-host`; verify its files and checksum independently.
3. Trigger only an **official host reload**; require runtime-distinguishable
   behaviour or an immutable build fingerprint proving revision B is loaded
   into the running service, not merely readable on disk.
4. Verify the same host PID, exactly one FlowGuard plugin, working native
   `/start` catalogue and read-only RPCs. No activation, decision or audit
   mutation is permitted.
5. Include absent service, unsafe URL, stale PID, lost connection, failed
   plugin, duplicate plugin and inside-service execution as negative cases.

**Result:** A single-revision reload or exact file write is insufficient.
Host support for reloading the **server runtime** of an installed package,
and a runtime revision fingerprint, must be verified. Zero-restart upgrade
remains **NOT_VERIFIED**; do not bypass the self-restart guard.

## D. Active-profile uninstall, isolated host

The opt-in native test `src/cli/opencode-native-install.smoke.test.ts`
installs an exact packed artifact in a private temporary home, launches a
real OpenCode V2 server, verifies one active FlowGuard plugin, performs the
uninstall **from another process while the server is running**, then calls
`client.location.reload`.

It now additionally verifies the host PID and liveness remain unchanged
across reload and uninstall, the remaining observer plugin stays active,
foreign dependency sentinels retain byte identity, all known managed entry
files disappear and the customer's `opencode.jsonc` remains byte-exact.
The CLI additionally preserves an existing `flowguard.json` with no valid
scope-matched ownership manifest and emits a post-uninstall notice that
managed file removal is **not** proof of running-host unload. Check both
negative cases before attempting any active-profile operation.
A test failure must not trigger cleanup of a user's actual profile.

With OpenCode 2.2.6 available on the runner, execute in an isolated
test environment:

```sh
FLOWGUARD_OPENCODE_HOST_E2E=1 \
  FLOWGUARD_TARBALL=/absolute/path/to/pinned-flowguard-core.tgz \
  OPENCODE_CLI=/absolute/path/to/opencode \
  npx vitest run src/cli/opencode-native-install.smoke.test.ts
```

The test is skipped in ordinary CI unless the live-host opt-in environment
is set. Verify the exact platform tarball and allow the test to create and
clean only its temporary home.

**Result:** Source-level test is hardened. A new successful run against the
exact PR artifact is required for isolated PASS. Uninstall of a real,
non-disposable active user profile stays explicitly **NOT_EXECUTED** and must
not be performed for acceptance.

## Abnahmeentscheidung

GO only for the evidence categories actually executed and version-bound.
Never infer governance approval from UI state; do not switch #1207 from Draft
or merge it solely because these checks exist.
