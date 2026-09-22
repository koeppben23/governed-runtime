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
- FlowGuard core tarball (build with `npm run build && npm pack` from the
  governed-runtime repo root)

## Quick Start

```bash
# Prepare and install FlowGuard into the demo workspace
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo

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
a redacted sharing archive as fully verifiable raw evidence (exit code 3). What
it proves — and the offline, TSA, publication-binding, and authenticity limits
it cannot cover — is documented in `EVIDENCE_PACKAGE.md`.

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
demos/java-task-manager/
├── README.md                    ← You are here
├── DEMO_SCRIPT.md               ← Live presentation script with talking points
├── RESET.md                     ← How to reset for a fresh demo
├── EVIDENCE_PACKAGE.md          ← Evidence-package verification scope and limits
├── run-demo-setup.sh            ← Prepare or prepare+install the demo project
├── run-demo-preflight.sh        ← Pre-flight checks before a live pitch
├── verify-evidence-package.mjs  ← Standalone offline package verifier
├── snapshot-demo.sh             ← Workspace checkpoint save/restore (visual only)
├── FALLBACK.md                  ← Pre-recorded fallback strategy for live presentations
├── review-fixtures/             ← Files copied by setup to create the optional /review branch
└── seed/                        ← The buggy starting state (a standalone Maven project)
    ├── .gitignore
    ├── pom.xml
    ├── TICKET.md
    ├── ADR_TICKET.md
    ├── mvnw / mvnw.cmd
    ├── .mvn/wrapper/
    └── src/...
```

## License

This demo project is part of the FlowGuard (governed-runtime) repository
and subject to the same license terms.
