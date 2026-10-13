# FlowGuard Demo — Java Task Manager

This demo is intentionally **not wired into CI**: live execution is a manual
presentation and repeatability scenario. The demo **contract** is enforced in
the unit suite by `src/documentation/__tests__/demo-contract.test.ts`, which
runs with the unit test suite (`npm run test:unit`).

## What This Demo Proves

The Java bug is deliberately small. This demo does **not** prove that an LLM
can fix a Java bug. It proves that FlowGuard's governance model applies to
**three independent workflows**:

| Flow                 | What It Governs                                                                                                    | Evidence                                            |
| -------------------- | ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------- |
| **Architecture**     | ADR creation and review — architectural decisions documented, independently reviewed, and human-approved           | ADR, Review Findings, Audit Trail                   |
| **Development**      | Code changes — ticket, plan, review, approval, automatic validation, and a required export before completion       | Plan Evidence, Impl Diff, Review Cards, Audit Trail |
| **Peer Review Flow** | External contributions — content-aware branch diff analysis with host-orchestrated findings and obligation binding | Review Report, Obligation Binding, Audit Trail      |

Each flow ends at its own terminal phase:

- **Architecture** completes at terminal `ARCH_COMPLETE` (no export rail) and
  may optionally be `/archive`d afterwards.
- **Peer Review Flow** completes at terminal `PEER_REVIEW_COMPLETE` (no
  approval gate) and may optionally be `/archive`d afterwards.
- **Development** requires `/export` before `COMPLETE`: `flowguard_export`
  materializes and verifies the required package and persists
  `ExportCompletionEvidence`. A blocked or failed export stays in
  `EXPORT_READY` and must not be described as complete.

`/export` and `/archive` are **not** synonyms: `/export` is the development
completion step at `EXPORT_READY`, while `/archive` is an operational action
for already-terminal sessions and defaults to a redacted sharing archive.

## Prerequisites

- JDK 21+
- Node.js 22+
- OpenCode CLI (`opencode`) in PATH
- FlowGuard core tarball (build with `npm run build && npm run pack:checksums`
  from the governed-runtime repo root; the script writes the tarball and the
  `checksums.sha256` file the installer requires next to it)

## Run all demos (one command)

`demos/run-all-demos.sh` is the supported entry point for a full live run. It
performs a mandatory dry-run environment gate (toolchain pins, npm 10 canary
install under `engine-strict`, run isolation, artifact checksum, provider ping)
and then runs the matrix, claim controls, risk-trigger controls and the replan
recovery sequentially with fresh roots:

```bash
demos/run-all-demos.sh /tmp/flowguard-demos-run
```

The wrapper requires Node from `.node-version`, OpenCode
`TESTED_OPENCODE_HOST_VERSION`, JDK 21+ and npm 10 (installed into the run root
when the ambient npm major differs). Runs are intentionally sequential: the
host installer uses a lock that the wrapper scopes per run root. Exit code `0`
means every scenario produced accepted evidence, `2` marks unreached proofs and
`1` a contract violation. See `demos/DEMO_ASSURANCE.md` for the result taxonomy
and the forensic findings this harness enforces.

## Quick Start

`run-demo-setup.sh` prepares fresh workspaces and optionally installs the
tarball. It does not call `/start`, dispatch a reviewer, or complete any flow.
Follow the live-evidence checklist below before claiming a demo was executed.

```bash
# From demos/java-task-manager/: prepare every live demo workspace
../../run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-demos
cd /tmp/flowguard-demos/java-task-manager

# Verify the starting state
./mvnw test
# Observe: 16 tests, 0 failures, 1 skipped.
# The skipped test is @Disabled because it exposes the bug.

# Open the workspace in OpenCode Desktop

# Follow DEMO_SCRIPT.md step by step
```

## The Bug

`TaskService.updateTask()` does not check whether a task ID exists before
mutating. On a non-existent ID, a `NullPointerException` propagates, returning
HTTP 500 instead of the correct HTTP 404.

A regression test for this case exists in `TaskControllerTest` but is annotated
`@Disabled`.

## Expected Outcomes

### Part 1 — Architecture Flow

After `/architecture`, a MADR-format ADR is created with `## Context`,
`## Decision`, and `## Consequences`. FlowGuard dispatches a host-orchestrated,
independent reviewer (`reviewDispatch`); the structured findings are captured
and bound to the review obligation and the frozen ADR digest. After human
approval at `ARCH_REVIEW`, the ADR status is `accepted` and the session reaches
terminal `ARCH_COMPLETE`. An optional `/archive` packages the terminal session
as a redacted sharing archive.

### Part 2 — Development Flow

After a successful FlowGuard session, two files are changed:

| File                                                                       | Change                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/main/java/com/example/taskmanager/service/TaskService.java`           | Add null-check in `updateTask()`, throw `TaskNotFoundException`                      |
| `src/test/java/com/example/taskmanager/controller/TaskControllerTest.java` | Enable `update_taskNotFound_returns404()`, assert `$.taskId`, and update its Javadoc |

The task is recorded from the seed ticket with `/task --file TICKET.md`: FlowGuard reads the file
itself and binds its content digest — no manual risk claim is required, because the effective risk
class is computed from the actual change (the Java fix classifies as STANDARD, so the full
independent implementation review runs). Only an explicitly named `Risk` / `Risk Class` /
`Risikoklasse` field could raise that class; bare file/URL references are blocked, and comments or
attachments are not part of the import (provider integration: epic #976).

All 16 tests pass (the previously skipped test is now enabled and green). The
session reaches `COMPLETE` only after `/export` materializes and verifies the
required package; a blocked or failed export leaves the session in
`EXPORT_READY`. If an independent review exhausts its budget with changes
requested, the human gate becomes a governance override gate: plain `/approve`
is blocked with `GOVERNANCE_OVERRIDE_REQUIRED`, and only `/override-approve`
(plus `/request-changes` and `/reject`) can proceed.

### Part 3 — Peer Review Flow

`/review` starts READY → PEER_REVIEW as autonomous system work, with no user
action and no approval gate. The host-orchestrated `flowguard-reviewer` child
session detects the structural omission in the `feature/add-due-date` branch:
`dueDate` is wired into the model and request DTO but silently dropped in the
service and response DTO. FlowGuard captures and binds the structured findings
to the review obligation, the attempt, and the frozen subject digest
(`reviewDispatch.completed`), writes the review report with explicit target
coverage, and reaches terminal `PEER_REVIEW_COMPLETE`. `changes_requested` is a
valid outcome; an optional `/archive` may follow.

### Optional A/B — Reduced Ceremony vs. Full Review

`REDUCED_CEREMONY.md` adds a controlled comparison on the same application: the
same documentation task (`docs/usage-notes.md`, TRIVIAL) runs twice, in two
fresh workspaces from the same seed, with identical team policy and identical
active checks — once with `policy.allowReducedCeremony: true` (complete
post-implementation checks → review waiver → human evidence gate → export) and
once explicitly set to `false` (identical checks → full independent
implementation review). The existing Java bugfix flow deliberately keeps the
full review. `run-reduced-ceremony-demo-setup.sh` creates both workspaces and
writes both policies explicitly; its `--verify-session` mode proves that
FlowGuard actually selected `build` + `test` as active checks before the demo
claims "2/2 passed". The repository-root `./run-demo-setup.sh` prepares this
comparison together with the main workspace by default. Use
`run-reduced-ceremony-demo-setup.sh` directly only when preparing the A/B
comparison on its own.

## Live Evidence Checklist

Workspace preparation is not a live run. Record a distinct host-session ID and
FlowGuard session ID for every row; the host-session ID is the package identity
used by `verify-evidence-package.mjs`. Do not reuse a session or a chat export
between flows.

`run-live-matrix.mjs` executes this checklist reproducibly: it reads the
toolchain pins from the canonical repository files (`opencode-runtime-compat.ts`
and `.node-version`), verifies the tarball against its `checksums.sha256`
sidecar before installing, prepares fresh workspaces, opts the repository
config into raw auditor archives next to the isolated global grant, runs every
step through real headless `opencode run` processes with an explicit `--dir`,
verifies the persisted host/worktree binding and each package, exports the
parent and reviewer-child host transcripts directly to files, validates JSON,
session/worktree/parent identity and message/part structure before registering
their hashes, records the installed
build identity, records recovered typed denials and successful reviewer re-arms while
stopping on any non-recoverable block, removes the isolated raw-export grant on exit, and exits
non-zero when any requested flow did not complete. It performs no governance
work itself.

The persisted terminal phase is the outcome authority: when a transport-level
block appears after the session already reached that phase, the flow records it
under `terminalBlocks` instead of discarding the completed flow. Each entry keeps
`phaseBefore`, `phaseAfter` and a `denialAfterTerminal` flag that is `true` only
when the terminal phase was already persisted before the turn — otherwise it stays
`null` and no ordering is claimed. Package verification still runs and fails the
flow if the required artifact is missing. Any block observed before the terminal
phase still stops the flow.

Recoverable typed denials are evidence-bound, never allow-listed blank. A denial
counts as resolved in-turn only when a later call of the same tool shares an
operation key (`same_turn_operation_recovery`). A later success without that
binding is recorded as `later_tool_success` — an observation that does NOT
resolve the denial: the next required step must prove a persisted state
transition (`next_step_state_transition:<step>`), otherwise the flow stops. A
structured reviewer re-arm is recorded as `structured_rearm` and supersedes a
terminal capture block only for the same obligation. `CONTINUE_AMBIGUOUS` is
different: it mutates nothing and demands an explicit flow choice, so it is
recorded as `pending_recovery` and becomes `recovered` only through the same
persisted-transition proof. A recoverable denial without such proof stops the
flow.

The architecture negative probe is a controlled denial step: the runner
requires the exact `ARCHITECTURE_CLAIM_INVALID` rejection, proves that the rejected
ADR was not persisted, and only then creates a complete Service-Layer Null-Safety
ADR aligned with `ADR_TICKET.md` and `TICKET.md`. The probe's runtime rejection is
separate runner evidence, not the ADR subject or repository evidence for its
claims. Full independent review and ordinary approval still apply; an exhausted
review is not bypassed with a governance override.

The probe governs a dedicated pristine seed copy
(`workspaces/java-task-manager-architecture-negative`). The development flow
modifies the main workspace, and a reviewer comparing a post-fix ADR against the
frozen base would correctly reject it; the copy keeps that comparison honest.

Failed exports remain as diagnostic bytes and stop the flow. Hashes of truncated
or structurally invalid JSON are never registered as accepted transcript evidence.
Filenames use the actual scenario name; child exports must identify its parent.

The separate [critical ProofGraph live-control contract](./PROOFGRAPH_LIVE_CONTROLS.md)
defines the positive and negative evidence required before claiming critical-claim
enforcement was verified. A claimless completion or an unrelated earlier gate
block does not satisfy that contract.

```bash
# Full matrix: builds + packs the current tree, prepares fresh workspaces,
# runs every flow, and verifies each package.
node demos/java-task-manager/run-live-matrix.mjs --root /tmp/flowguard-live-run

# Toolchain/preflight check only (no live run).
node demos/java-task-manager/run-live-matrix.mjs --root /tmp/flowguard-live-run --check
```

| Flow         | Workspace                      | Required terminal state    | Individual evidence package                                                |
| ------------ | ------------------------------ | -------------------------- | -------------------------------------------------------------------------- |
| Architecture | `java-task-manager`            | `ARCH_COMPLETE`            | Create a raw `/archive`; verify as `architecture` / `ARCH_COMPLETE`.       |
| Development  | `java-task-manager`            | `COMPLETE` after `/export` | Verify the `/export` package as `development` / `EXPORT_READY`.            |
| Peer review  | `java-task-manager`            | `PEER_REVIEW_COMPLETE`     | Create a raw `/archive`; verify as `peer-review` / `PEER_REVIEW_COMPLETE`. |
| Reduced-on   | `reduced-ceremony/reduced-on`  | `COMPLETE` after `/export` | Verify its `/export` package as `development` / `EXPORT_READY`.            |
| Reduced-off  | `reduced-ceremony/reduced-off` | `COMPLETE` after `/export` | Verify its `/export` package as `development` / `EXPORT_READY`.            |

Mark the live record only after the terminal state and individual verification
both succeeded:

- [ ] Architecture: `ARCH_COMPLETE`, distinct session IDs, raw package verified.
- [ ] Development: `COMPLETE`, distinct session IDs, `/export` package verified.
- [ ] Peer Review: `PEER_REVIEW_COMPLETE`, distinct session IDs, raw package verified.
- [ ] Reduced-on: `COMPLETE`, distinct session IDs, `/export` package verified.
- [ ] Reduced-off: `COMPLETE`, distinct session IDs, `/export` package verified.

For Architecture and Peer Review, enable
`archive.redaction.allowRawExport=true` and run:

```text
/archive redactionMode=none includeRaw=true
```

Verify each package independently, substituting the recorded host session ID,
flow, and package snapshot phase from the table:

```bash
node demos/java-task-manager/verify-evidence-package.mjs "$PKG" \
  --expect-session "$HOST_SESSION_ID" \
  --expect-flow <architecture|development|peer-review> \
  --expect-phase <ARCH_COMPLETE|EXPORT_READY|PEER_REVIEW_COMPLETE>
```

`evidence-manifest.example.json` intentionally remains the three-flow manifest
for Architecture, Development, and Peer Review. Do not extend it to imply that
the two reduced-ceremony flows ran; retain their separately verified packages
and this checklist instead.

## Archive and Raw Evidence

`/archive` is the operational export for terminal sessions. It creates a
redacted sharing archive by default and reports
`integrityCapability: not_verifiable` and `verificationStatus: not_run`, rather
than claiming to verify an archive that intentionally excludes raw session
state and the canonical audit trail.

For a confidential auditor package, configure global
`archive.redaction.allowRawExport=true` and run the raw archive export:

```text
/archive redactionMode=none includeRaw=true
```

Among `/archive` outputs, only that raw-evidence package can report
`integrityCapability: verifiable` and `verificationStatus: passed`. This is
separate from the development completion step: `/export` at EXPORT_READY
materializes its own required verifiable package (no arguments) and reports
`integrityCapability: verifiable` and `verificationStatus: passed` in its typed
`exportCompletion` projection.

The retired form /export redactionMode=none includeRaw=true is not accepted:
`/export` takes no arguments and is the development completion step, not an
archive alias.

## Verify the Evidence Package

The `/export` package is a raw, offline-verifiable evidence package. A
standalone verifier recomputes its checksum, member inventory, file digests,
canonical content digest, session identity, and archived audit chain:

```bash
node demos/java-task-manager/verify-evidence-package.mjs <package.tar.gz> \
  --expect-session <session-id> --expect-flow development --expect-phase EXPORT_READY
```

It exits non-zero on any tamper or session misassignment and refuses to present
a redacted sharing archive as fully verifiable raw evidence (exit code 3). The
three original demo sessions (architecture, development, peer-review) and their external
host chat exports are bound by a small evidence manifest template
(`evidence-manifest.example.json`), verified with:

```bash
node demos/java-task-manager/verify-evidence-package.mjs --manifest evidence-manifest.json
```

The manifest check also fails when two flows share byte-identical artifacts —
the "peer-review chat export is a copy of the architecture export" defect — and
when one session id is declared for more than one flow. Host chat exports are
manually assigned, hash-secured supplementary evidence, never FlowGuard
authority: the manifest proves their bytes, not an independently observed
chat-session binding. What
the verifier proves — and the offline, TSA, publication-binding, and
authenticity limits it cannot cover — is documented in `EVIDENCE_PACKAGE.md`.

## Assurance Boundaries

FlowGuard validates the host adapter against its host contract at boot, but the
advertised host capabilities are **contract-attested, not runtime-verified**:
the plugin logs `HOST_CAPABILITY_UNVERIFIED` as a diagnostic warning (it never
blocks a governance path), and the reviewer capability is verified lazily on
the real invocation path. This boundary is documented in
`docs/opencode-host-boundary-attack-matrix.md` (PL-03, F-04). Cross-check the
claim before presenting: a capability claim is only as strong as the adapter
contract it was validated against.

## Directory Structure

```text
run-demo-setup.sh                  ← Public entry point: prepares all live demos from the repository root
demos/java-task-manager/
├── README.md                    ← You are here
├── DEMO_SCRIPT.md               ← Live presentation script with talking points
├── REDUCED_CEREMONY.md          ← Optional A/B comparison: reduced vs. full implementation review
├── RESET.md                     ← How to reset for a fresh demo
├── EVIDENCE_PACKAGE.md          ← Evidence-package verification scope and limits
├── evidence-manifest.example.json ← Template binding the three sessions to their artifacts
├── run-main-demo-setup.sh       ← Main-workspace setup primitive
├── run-reduced-ceremony-demo-setup.sh ← Two fresh workspaces, explicit policies, --verify-session
├── run-demo-preflight.sh        ← Pre-flight checks before a live pitch
├── verify-evidence-package.mjs  ← Standalone offline package verifier
├── snapshot-demo.sh             ← Workspace checkpoint save/restore (visual only)
├── FALLBACK.md                  ← Pre-recorded fallback strategy for live presentations
├── review-fixtures/             ← Files copied by setup to create the optional /review branch
└── seed/                        ← The buggy starting state (a standalone Maven project)
    ├── .gitignore
    ├── pom.xml
    ├── TICKET.md
    ├── TICKET_DOCS.md
    ├── ADR_TICKET.md
    ├── mvnw / mvnw.cmd
    ├── .mvn/wrapper/
    └── src/...
```

## License

This demo project is part of the FlowGuard (governed-runtime) repository
and subject to the same license terms.
