# Developing and Debugging FlowGuard

## 1. Purpose

This guide is the canonical development and debugging workflow for FlowGuard on
macOS with IntelliJ IDEA Ultimate. It covers the four runtime boundaries —
Vitest/core, CLI, MCP, and the live OpenCode plugin host — and explains which
debugger to use for which defect class.

FlowGuard is not a single process. Treating it as one leads to debugging the
host instead of the defect. Reproduce below the host boundary first.

This document is developer documentation. It does not change FlowGuard runtime
semantics, governance behavior, or the fail-closed boundaries.

## 2. Supported development baseline

Repository development and product runtime support are separate contracts. Do
not mix them.

**Repository development runtime** (authority: `.node-version`, `devEngines`):

| Contract          | Value                         |
| ----------------- | ----------------------------- |
| `.node-version`   | `22.22.2`                     |
| `devEngines` node | `>=22.22.2` (`onFail: error`) |
| `devEngines` npm  | `>=10.9.2` (`onFail: warn`)   |

**Product runtime support** (authority: `package.json#engines`):

| Contract | Value                               |
| -------- | ----------------------------------- |
| Node     | `^20.0.0 \|\| ^22.0.0 \|\| ^24.0.0` |
| npm      | `^10.0.0`                           |

Development MUST use a Node runtime that satisfies the `devEngines` range. A
Node version that only satisfies `engines` is supported for running released
FlowGuard, not for building this repository.

Check the effective runtime:

```bash
node --version
npm --version
```

## 3. Runtime architecture for debugging

```text
                 FlowGuard Core
                       │
       ┌───────────────┼───────────────┐
       │               │               │
     Vitest           MCP             CLI
       │               │               │
       └───────────────┼───────────────┘
                       │
                 OpenCode Plugin
```

Derive the debug path from the defect class:

| Problem class                            | Primary debug path                            |
| ---------------------------------------- | --------------------------------------------- |
| Domain / policy / state / machine        | Vitest unit                                   |
| Tool / workflow / governance integration | Vitest integration                            |
| Architecture rules                       | Vitest architecture                           |
| CLI / doctor / installer entry           | Node debugger                                 |
| MCP tool invocation                      | Node inspector + MCP client                   |
| OpenCode hook / host semantics           | Live OpenCode                                 |
| Host-specific process failure            | OpenCode/Bun debugging only as the last layer |

> Do not begin debugging a FlowGuard defect through the live AI host unless the
> defect depends on host lifecycle or host semantics.

## 4. macOS prerequisites

- Node.js managed by a version manager (nvm, fnm, asdf, or mise) so the
  repository's `.node-version` is honored.
- npm `>=10.9.2`.
- IntelliJ IDEA Ultimate.
- Bun may be used to debug the OpenCode host process itself.

> Bun is not the default FlowGuard development runtime.

## 5. IntelliJ IDEA Ultimate setup

Enable the bundled capabilities:

```text
JavaScript / TypeScript
Node.js
JavaScript Debugger
Vitest
```

Set the project Node runtime:

```text
Settings
→ Languages & Frameworks
→ JavaScript Runtime
```

```text
Node interpreter: node 22.22.2+ (project / .node-version)
$PROJECT_DIR$ as project root
```

The repository ships shared run configurations under [`.run/`](../../.run) so a
fresh clone is debuggable without manual configuration. They contain only
`$PROJECT_DIR$` macros — no machine-specific paths.

## 6. Initial checkout and verification

```bash
git clone <repository>
cd governed-runtime

node --version
npm --version

npm ci
npm run check
npm test
npm run build
```

`dist/` is the compiled artifact used by the CLI, MCP, and install paths. Tests
run from TypeScript sources via Vitest and do not need a build.

TypeScript debugging relies on the compiler settings in `tsconfig.json`:

```text
sourceMap: true
declarationMap: true
```

Both are enabled in this repository; keep them enabled.

## 7. Debugging strategy

Vitest is the primary debug path. Use the IDE's gutter actions on the relevant
test project instead of starting a second ad-hoc Node pipeline.

Available Vitest projects: `unit`, `integration`, `smoke`, `scripts`, `evals`,
`fuzz`, `conformance`.

### 7.1 Unit tests

```bash
npm run test:unit
```

Use for domain, policy, state, machine, and local logic.

### 7.2 Integration tests

```bash
npm run test:integration
```

Use for tool, workflow, and governance-integration behavior.

### 7.3 Architecture tests

```bash
npm run test:architecture
```

Runs the architecture suite (`--project unit src/architecture/`) and enforces
the dependency, placement, cycle, and invariant guards.

### 7.4 Single test

```bash
npx vitest run --project integration \
  src/integration/runtime-flow-e2e-contract.test.ts
```

In IntelliJ, prefer the Vitest gutter next to the test or suite. There is
deliberately no `npm run debug:integration` script: the IDE-native Vitest
debugger and `npm run test:integration` are the canonical paths.

### 7.5 CLI

See section 8.

### 7.6 MCP server

See section 9.

### 7.7 OpenCode plugin

Live-host debugging is required only for plugin lifecycle, hook boundaries,
native task/reviewer orchestration, host events, session compaction, and host
process behavior. See section 16.

## 8. CLI debugging

Build first — the CLI runs from `dist/`:

```bash
npm run build
npm run debug:cli -- doctor --install-scope repo --log-mode console
```

`debug:cli` starts:

```text
node --inspect-brk=127.0.0.1:9231 dist/cli/install.js
```

IntelliJ: use `FlowGuard - CLI Doctor` from the shared run configurations, or
attach with:

```text
Attach to Node.js/Chrome
Host: 127.0.0.1
Port: 9231
```

The `--inspect-brk` process waits until the debugger attaches. Set breakpoints
in `src/**/*.ts`; the debugger maps through the published source maps.

## 9. MCP debugging

Build first:

```bash
npm run build
npm run debug:mcp
```

`debug:mcp` starts:

```text
node --inspect-brk=127.0.0.1:9230 dist/mcp-server/index.js
```

```text
MCP client
   │
   │ stdin/stdout JSON-RPC
   ▼
flowguard-mcp Node process
   │
   └──── inspector TCP 9230 ──── IntelliJ
```

The process waits for JSON-RPC input on stdio. Starting it alone is expected to
sit idle; either drive it from an MCP client or use the shared
`FlowGuard - MCP Server` run configuration to inspect startup and tool
registration.

> Never use stdout for ad-hoc debugging of `flowguard-mcp`. stdout is part of
> the MCP protocol transport.

FlowGuard enforces this with its stdout guard in
[`src/mcp-server/stdout-guard.ts`](../../src/mcp-server/stdout-guard.ts).

## 10. Dogfood installation from source

The real release path is the only supported dogfood path:

```bash
npm ci
npm run build
npm run pack:checksums

TARBALL="flowguard-core-$(node -p 'require("./package.json").version').tgz"
```

`npm run pack:checksums` writes the tarball and `checksums.sha256` in the
repository root. Both are local artifacts: the tarball is git-ignored, and
`checksums.sha256` must not be committed. Remove them when the dogfood session
ends.

For development, use `--install-scope repo`. It installs into the target
repository's `.opencode/` instead of the global developer environment.

## 11. Isolated playground repository

Recommended layout:

```text
~/dev/
  governed-runtime/
  flowguard-playground/
```

Do not use `governed-runtime` itself as the dogfood target. Create a fresh
repository:

```bash
mkdir -p ../flowguard-playground
cd ../flowguard-playground

git init
git commit --allow-empty -m "chore: initialize FlowGuard playground"
```

Then install the tarball built in section 10:

```bash
npx --yes \
  --package "../governed-runtime/$TARBALL" \
  flowguard install \
  --core-tarball "../governed-runtime/$TARBALL" \
  --checksums-file "../governed-runtime/checksums.sha256" \
  --install-scope repo \
  --force
```

Verify:

```bash
npx --yes \
  --package "../governed-runtime/$TARBALL" \
  flowguard doctor \
  --install-scope repo
```

The installation lands in `flowguard-playground/.opencode/`.

> FlowGuard should normally be debugged against a separate git worktree so
> repository discovery, dirty-state detection, changed-file analysis and audit
> evidence describe the target repository instead of FlowGuard's own source
> checkout.

## 12. Logging and runtime evidence

For live debugging, enable structured debug logging in the target repository's
FlowGuard configuration:

```json
{
  "schemaVersion": "v1",
  "logging": {
    "level": "debug",
    "mode": "file+console"
  }
}
```

Log path:

```text
<workspace>/.opencode/logs/flowguard-YYYY-MM-DD.log
```

Logs are structured JSONL. Keep the evidence levels apart:

```text
Debugger
→ imperative execution flow

Structured FlowGuard logs
→ diagnostic runtime observations

Session state + audit chain
→ governance authority/evidence
```

> Diagnostic logs are not governance evidence.

### Recommended breakpoints

| Boundary                    | Location                                                     |
| --------------------------- | ------------------------------------------------------------ |
| OpenCode composition root   | `src/integration/plugin.ts`, `FlowGuardAuditPlugin()`        |
| Host before-boundary        | `src/integration/plugin-beforehooks.ts`                      |
| Host after-boundary         | `src/integration/plugin-afterhooks.ts`                       |
| MCP boundary                | `src/mcp-server/server.ts`, `src/mcp-server/tool-adapter.ts` |
| Tool execution              | `src/integration/tools/`                                     |
| Review orchestration        | `src/integration/review/`                                    |
| Runtime identity / recovery | `src/integration/runtime-instance.ts`                        |
| Audit durability            | `src/integration/audit-outbox.ts`                            |
| State authority             | `src/state/`                                                 |

## 13. Source maps

- `tsc` emits `dist/**/*.js` plus `.js.map` files (`sourceMap: true`) and
  declaration maps (`declarationMap: true`).
- Tests execute TypeScript sources through Vitest; breakpoints in
  `src/**/*.test.ts` and imported sources bind directly.
- CLI, MCP, and installer breakpoints bind to `src/**/*.ts` through the source
  maps when the debugger runs the `dist/` entrypoint.
- Rebuild after source changes: `npm run build`. The shared run configurations
  run the build as a before-launch task.

## 14. Troubleshooting

| Symptom                                    | Resolution                                                                             |
| ------------------------------------------ | -------------------------------------------------------------------------------------- |
| Node version mismatch                      | `node --version` must satisfy `>=22.22.2`; switch with your version manager.           |
| `--inspect-brk` seems to hang              | Expected: the process waits for the debugger on `127.0.0.1:9230`/`9231`.               |
| Inspector port already in use              | Find the owner with `lsof -i :9231` and free it, or change the port in the npm script. |
| `flowguard-mcp` appears idle               | Expected: it waits for JSON-RPC on stdin. Use an MCP client.                           |
| IntelliJ does not find Vitest              | Run `npm ci`, then rescan/reimport; verify `vitest.config.ts` is detected.             |
| Breakpoints stay unbound in `dist/`        | Rebuild (`npm run build`) and confirm the debugger runs the `dist/` entrypoint.        |
| OpenCode host differs from the baseline    | Check `opencode --version`; only `1.18.30` is the verified host contract.              |
| Checksum verification fails during install | Rebuild tarball and `checksums.sha256` from the same clean commit.                     |

## 15. What not to do

```text
Prefer:
FlowGuard structured logger
breakpoints
existing audit/state artifacts

Avoid:
console.log() additions in runtime/plugin paths
```

- Do not add debug flags, bypasses, or debug-only runtime authorities to
  production code.
- Do not use `console.log()` in runtime or plugin paths. In MCP it corrupts the
  protocol transport; in the host it can cause unwanted side effects.
- Do not treat diagnostic logs as governance evidence.
- Do not commit `.idea/`, `*.iml`, `dist/`, `.opencode/`, `*.tgz`, or
  `checksums.sha256`.
- Do not use `npm link` as a dogfood mechanism; use the real
  `pack → checksums → install` path.
- Do not add a second Node/Vitest debug pipeline beside the IDE-native Vitest
  debugger.
- Do not debug generic domain defects through the live AI host.

## 16. OpenCode live debugging

Live OpenCode debugging is required for:

```text
plugin lifecycle
command.execute.before
tool.execute.before
tool.execute.after
native Task/reviewer orchestration
host events
session compaction
host process behavior
```

It is not required for:

```text
state transitions
policy evaluation
tool domain logic
audit algorithms
MCP mapping
generic workflow behavior
```

Reproduce those through Vitest first.

Check the host version before a live session:

```bash
opencode --version
```

```text
exact tested version 1.18.30
→ verified host-contract baseline

other version
→ compatible-unverified unless explicitly classified otherwise
```

## 17. Verification checklist

Use this checklist when validating a fresh development setup:

```text
[ ] Fresh IntelliJ IDEA Ultimate project import works
[ ] Project Node runtime resolves to Node >=22.22.2
[ ] FlowGuard - Unit starts
[ ] TypeScript breakpoint is hit in a unit test
[ ] FlowGuard - Integration starts
[ ] TypeScript breakpoint is hit in integration code
[ ] FlowGuard - Architecture starts
[ ] FlowGuard - CLI Doctor stops in TypeScript source
[ ] FlowGuard - MCP Server stops in TypeScript source
[ ] Source-map mapping resolves dist/*.js → src/*.ts
[ ] Dogfood tarball builds
[ ] Repo-scoped playground install succeeds
[ ] flowguard doctor succeeds in playground
[ ] OpenCode loads the repo-scoped FlowGuard installation
[ ] /start or /hydrate reaches FlowGuard
[ ] debug logging appears in the documented location
```
