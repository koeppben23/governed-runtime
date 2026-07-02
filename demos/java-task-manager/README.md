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
- Node.js 20+
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

## Optional: Regulated Four-Eyes Walkthrough

The main flow runs in `team` mode (human-gated, self-approval allowed). To also
demonstrate the **four-eyes principle** (initiator ≠ approver, enforced fail-closed
in `regulated` mode), install into a **separate** workspace with the regulated
policy and follow the "Regulated Mode & Four-Eyes" section in `DEMO_SCRIPT.md`:

```bash
./run-demo-setup.sh --install --tarball /path/to/flowguard-core-*.tgz \
  --policy-mode regulated /tmp/flowguard-java-regulated-demo
```

The mode is set by the install flag (persisted to `.opencode/flowguard.json`);
`/start` inherits it. Two ready-made identity templates live in `actor-claims/`
(`m.weber` as initiator, `t.schneider` as reviewer).

Actor identity comes from the OpenCode host's environment
(`FLOWGUARD_ACTOR_CLAIMS_PATH`), so it must be visible to the host process and set
**before** it starts. The reliable, officially-documented host for this is the
**terminal TUI** (`opencode` in a terminal), which inherits the shell environment.
The **Desktop GUI** app's environment inheritance is not documented by OpenCode —
if you must use it, set a persistent user environment variable and relaunch. The
four-eyes switch is done by pointing that variable at one fixed working-copy file
and **editing that file's contents** between hydrate and approve (FlowGuard re-reads
it on every command) — no host restart, no mid-session env change. See the
"Regulated Mode & Four-Eyes" section in `DEMO_SCRIPT.md` for the exact commands and
the Desktop caveat. Keep this in its own target directory so it never pollutes the
main `team`-mode demo.

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
├── FALLBACK.md            ← Pre-recorded fallback strategy for live presentations
├── actor-claims/          ← Claim files for the optional regulated four-eyes walkthrough
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
