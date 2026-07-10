# FlowGuard Demo — Java Task Manager

This demo is intentionally **not wired into CI**. It is a manual presentation
and repeatability scenario for demonstrating governed AI-assisted delivery
end-to-end with FlowGuard.

## What This Demo Proves

The Java bug is deliberately small. This demo does **not** prove that an LLM
can fix a Java bug. It proves that an AI-assisted change is routed through
**ticket, plan, review, approval, checks, and exportable evidence** — instead
of disappearing informally in a chat.

## Prerequisites

- JDK 21+
- Node.js — use the repository-controlled version from [#619](../../issues/619). This demo requires #619 to be completed before pitch rehearsal.
- OpenCode CLI (`opencode`) in PATH
- FlowGuard core tarball (build with `npm run build && npm pack` from the
  governed-runtime repo root)

## Quick Start

```bash
# Option A: Prepare + install in one step
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo

# Option B: Prepare only, then install manually
./run-demo-setup.sh /tmp/flowguard-java-demo
cd /tmp/flowguard-java-demo
npx --package /path/to/flowguard-core-*.tgz flowguard install \
  --install-scope repo --policy-mode team \
  --core-tarball /path/to/flowguard-core-*.tgz --force

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

## Expected Outcome After the Flow

After a successful FlowGuard session, two files are changed:

| File                                                                       | Change                                                          |
| -------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `src/main/java/com/example/taskmanager/service/TaskService.java`           | Add null-check in `updateTask()`, throw `TaskNotFoundException` |
| `src/test/java/com/example/taskmanager/controller/TaskControllerTest.java` | Remove `@Disabled` from `update_taskNotFound_returns404()`      |

All 16 tests pass (the previously skipped test is now enabled and green).

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
    ├── mvnw / mvnw.cmd
    ├── .mvn/wrapper/
    └── src/...
```

## License

This demo project is part of the FlowGuard (governed-runtime) repository
and subject to the same license terms.
