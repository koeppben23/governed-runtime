# FlowGuard Demo — Java Task Manager

This demo is intentionally **not wired into CI**. It is a manual presentation
and repeatability scenario for demonstrating three governed AI-assisted
delivery flows end-to-end with FlowGuard.

## What This Demo Proves

The Java bug is deliberately small. This demo does **not** prove that an LLM
can fix a Java bug. It proves that FlowGuard's governance model applies to
**three independent workflows**:

| Flow               | What It Governs                                                                                          | Evidence                                            |
| ------------------ | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------- |
| **Architecture**   | ADR creation and review — architectural decisions documented, independently reviewed, and human-approved | ADR, Review Findings, Audit Trail                   |
| **Implementation** | Code changes — ticket, plan, review, approval, checks, and implementation                                | Plan Evidence, Impl Diff, Review Cards, Audit Trail |
| **Review**         | External contributions — content-aware branch diff analysis with subagent findings                       | Review Report, Obligation Binding, Audit Trail      |

Each flow produces exportable evidence archives. The default redacted sharing
archive is intentionally `not_verifiable`: canonical audit-chain verification
requires an explicitly authorized raw-evidence export.

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
`## Decision`, and `## Consequences`. The ADR is independently reviewed by
the `flowguard-reviewer` subagent. After human approval at `ARCH_REVIEW`,
the ADR status is `accepted` and the session reaches `ARCH_COMPLETE`.
The evidence archive contains the ADR, review findings, and audit trail.

### Part 2 — Implementation Flow

After a successful FlowGuard session, two files are changed:

| File                                                                       | Change                                                                               |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `src/main/java/com/example/taskmanager/service/TaskService.java`           | Add null-check in `updateTask()`, throw `TaskNotFoundException`                      |
| `src/test/java/com/example/taskmanager/controller/TaskControllerTest.java` | Enable `update_taskNotFound_returns404()`, assert `$.taskId`, and update its Javadoc |

All 16 tests pass (the previously skipped test is now enabled and green).

### Part 3 — Review Flow

The `flowguard-reviewer` subagent detects the structural omission in the
`feature/add-due-date` branch: `dueDate` is wired into the model and request
DTO but silently dropped in the service and response DTO. The review report
and evidence are exported.

## Archive Verification

`/export` creates a redacted sharing archive by default. It reports
`archiveStatus: not_verifiable`, rather than claiming to verify an archive that
intentionally excludes raw session state and the canonical audit trail.

For a confidential auditor package, configure global
`archive.redaction.allowRawExport=true` and run:

```text
/export redactionMode=none includeRaw=true
```

Only that raw-evidence package can report `archiveStatus: verified`.

This manual-export permission does not alter FlowGuard's regulated completion
path, which creates its mandatory local raw-evidence archive automatically.

## Directory Structure

```text
demos/java-task-manager/
├── README.md              ← You are here
├── DEMO_SCRIPT.md         ← Live presentation script with talking points
├── RESET.md               ← How to reset for a fresh demo
├── run-demo-setup.sh      ← Prepare or prepare+install the demo project
├── run-demo-preflight.sh  ← Pre-flight checks before a live pitch
├── snapshot-demo.sh       ← Workspace checkpoint save/restore
├── FALLBACK.md            ← Pre-recorded fallback strategy for live presentations
├── review-fixtures/       ← Files copied by setup to create the optional /review branch
└── seed/                  ← The buggy starting state (a standalone Maven project)
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
