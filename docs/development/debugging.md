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

**Product runtime support** (authority: `package.json`, field `engines`):

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

| Problem class                            | Primary debug path                               |
| ---------------------------------------- | ------------------------------------------------ |
| Domain / policy / state / machine        | Vitest unit                                      |
| Tool / workflow / governance integration | Vitest integration                               |
| Architecture rules                       | Vitest architecture                              |
| CLI / doctor / installer entry           | Node debugger                                    |
| MCP tool invocation                      | Node inspector + MCP client                      |
| OpenCode hook / host semantics           | Live OpenCode diagnostics                        |
| Host-specific process failure            | OpenCode host diagnostics only as the last layer |

> Do not begin debugging a FlowGuard defect through the live AI host unless the
> defect depends on host lifecycle or host semantics.

## 4. macOS prerequisites

- Node.js managed by a version manager (nvm, fnm, asdf, or mise) so the
  repository's `.node-version` is honored.
- npm `>=10.9.2`.
- IntelliJ IDEA Ultimate.

> Bun is not part of the verified FlowGuard development path. Do not add a
> second host debug pipeline for it.

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

# nvm does not read .node-version by default; pass it explicitly.
nvm install "$(cat .node-version)"
nvm use "$(cat .node-version)"

node --version   # v22.22.2
npm --version    # >=10.9.2

npm ci
npm run check
npm test
npm run build
```

For `fnm`, `asdf`, or `mise`, select the version declared in `.node-version`
with that tool. Do not add a second version file merely to satisfy one manager;
`.node-version` is the canonical authority.

`npm ci` is the reproducible checkout command: it installs exactly from the
committed lockfile. Use `npm install` only when intentionally changing
dependencies, because it is the repository's required command for updating the
lockfile.

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

The shared `FlowGuard - CLI Doctor` configuration runs from `$PROJECT_DIR$` and
therefore inspects the source repository itself: a fresh clone has no
repo-scoped `.opencode/` installation. It exercises the source-repo CLI boundary
and failure paths (missing install, diagnostics), which is useful on purpose.

For the successful installed-product path, start the doctor from the playground
and attach:

```bash
cd ../flowguard-playground
node --inspect-brk=127.0.0.1:9231 ../governed-runtime/dist/cli/install.js doctor --install-scope repo
```

or with the packaged CLI:

```bash
NODE_OPTIONS=--inspect-brk=127.0.0.1:9231 npx --yes \
  --package "../governed-runtime/$TARBALL" flowguard doctor --install-scope repo
```

The first command runs against the local build, so breakpoints in `src/**/*.ts`
bind through the source maps. The packaged invocation runs the installed
artifact, where breakpoints bind in `dist/` JavaScript (the tarball ships
`dist/` only). Attach IntelliJ to `127.0.0.1:9231` in both cases.

## 9. MCP debugging

MCP over stdio is a child-process lifecycle: the MCP client spawns the server and
owns its stdin/stdout. A separately started FlowGuard process has no stdio
endpoint that a normal MCP client could attach to later. To debug real
request/tool handling, let the client launch an inspected server process.

### 9.1 Client-launched inspected server (request/tool debugging)

```bash
npm run build

npx --yes @modelcontextprotocol/inspector \
  node --inspect-brk=127.0.0.1:9230 dist/mcp-server/index.js
```

The official MCP Inspector spawns the command and speaks JSON-RPC over the
child's stdio. `--inspect-brk` pauses the server until the debugger attaches;
then trigger `initialize`, `tools/list`, or a tool call from the Inspector UI.

```text
MCP client / Inspector
        │ spawn (stdio)
        ▼
node --inspect-brk=127.0.0.1:9230 dist/mcp-server/index.js
        │
        └──── inspector TCP 9230 ──── IntelliJ
```

Attach IntelliJ with `Attach to Node.js/Chrome`, host `127.0.0.1`, port `9230`.
Use `--inspect` instead of `--inspect-brk` when the client handshake must not
block and you can attach after startup.

Any MCP client can launch the inspected process the same way:

```json
{
  "mcpServers": {
    "flowguard": {
      "command": "node",
      "args": [
        "--inspect=127.0.0.1:9230",
        "<absolute-path>/dist/mcp-server/index.js"
      ]
    }
  }
}
```

### 9.2 Standalone startup inspection

```bash
npm run build
npm run debug:mcp
```

`debug:mcp` starts:

```text
node --inspect-brk=127.0.0.1:9230 dist/mcp-server/index.js
```

Nothing connects to this process: it waits in `--inspect-brk` until IntelliJ
attaches, and then waits for stdin. Use it — or the shared
`FlowGuard - MCP Server` run configuration — only to inspect startup and tool
registration. It is not a client attach point, and adding a client later does
not work through stdio.

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

### Latency diagnostics

Two `info` log lines carry diagnostic latency. They change no state, audit,
or enforcement behavior, and they contain identifiers, codes, and numbers only.

`hook` / `tool.execute.after` (the existing diagnostic log label) adds the
following fields. This label is retained diagnostic vocabulary, not a V1 hook
registration: the host registration is native V2 `execute.after`.

| Field                 | Meaning                                                                                                                                                                                                                         |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `callId`              | Host call id, when the host supplies one.                                                                                                                                                                                       |
| `beforeToAfterMs`     | End of a fully passed FlowGuard before-hook to entry of the after-hook: host execution plus host overhead, not pure tool time.                                                                                                  |
| `durationUnavailable` | Instead of a number: `call_id_missing`, `session_id_missing`, or `start_not_observed` (restart, eviction, or no passed before-hook). Never reported as 0.                                                                       |
| `hostToolOutcome`     | Tool result as it reached the after-hook, BEFORE further after-hook processing: `flowguard_blocked` (with `hostToolCode`), `flowguard_returned`, or `unknown`. Non-FlowGuard host tools (bash, edit, ...) are always `unknown`. |
| `statusProjection`    | `flowguard_status` only: the selected projection (`finish`, `whyBlocked`, ..., `full`).                                                                                                                                         |

`orchestrator` / `review structured followup timing` (one line per structured
follow-up) carries `obligationId`, `childSessionId`, and either
`followupPromptMs` with `promptOutcome` (`responded` or `threw`) or
`followupPromptMsUnavailable: not_invoked` when no host prompt was sent. It
times only the host prompt, not agent resolution, validation, or binding.

Limits: the native reviewer subagent bypasses the generic tool hooks, so its
execution is not covered by `beforeToAfterMs`; use the host session export
for Task and model timings. These lines are absent while the file sink is not
yet active, when the configured level is above `info`, or when an enabled rate
limit drops them; absence is not a measurement.

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
| OpenCode host differs from the baseline    | Check `opencode --version` and compare it with the pins in `.sdk-baselines/opencode/`. |
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

## 16. OpenCode V2 live debugging

Live OpenCode debugging is required only for host-owned behavior:

```text
plugin discovery and lifecycle
native command callbacks (command.transform)
execute.before / execute.after
native reviewer subagent/reviewer orchestration
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

### 16.1 Verified V2 host baseline

The repository keeps the API baseline and the native CLI candidate separate:

| Contract             | Authority                                    | Value                                         |
| -------------------- | -------------------------------------------- | --------------------------------------------- |
| Native API packages  | `.sdk-baselines/opencode/version.json`       | `@opencode/plugin` / `@opencode/client` 2.2.7 |
| Native CLI candidate | `.sdk-baselines/opencode/cli-candidate.json` | `@opencode/cli` 2.2.5                         |

Check the installed host before a live session:

```bash
opencode --version
```

Expected for the candidate smoke path: `opencode v2.2.5`. A different version is
`compatible-unverified` unless the repository records an explicit classification
for it. The V2 API baseline is not a claim that every 2.2.x binary is accepted.

The following diagnostic commands were verified against OpenCode `v2.2.5` on
macOS on 2026-11-17:

```bash
opencode --version
opencode debug paths
opencode debug config
opencode plugin list
```

`opencode debug paths` is the authority for the host's data, config, state, log,
and temporary directories. `opencode debug config` shows the configuration
sources. `opencode plugin list` must show FlowGuard for the installation under
test. For a repo-scoped install, the plugin source is:

```text
<playground>/.opencode/plugins/flowguard/index.ts
```

Start a private V2 server for a live session; do not replace a running user
service:

```bash
opencode serve --port 4096
```

Add `--log-level debug --print-logs` to the `serve` invocation when you need the
host diagnostic stream. Use `/reload` after plugin or configuration changes for
normal rediscovery, then re-run `opencode plugin list`; file presence alone does
not prove that the host loaded the plugin.

FlowGuard's structured logs remain the product diagnostic authority. Enable them
in the target repository's FlowGuard configuration:

```json
{
  "schemaVersion": "v1",
  "logging": {
    "level": "debug",
    "mode": "file+console"
  }
}
```

Log path: `<workspace>/.opencode/logs/flowguard-YYYY-MM-DD.log`.

Diagnostic logs are not governance evidence. Keep debugger flow, structured
logs, and session/audit authority separate.

### 16.2 Debugging FlowGuard code loaded by the host

Use the OpenCode CLI, not the desktop app, for host-boundary debugging. The
desktop app adds an Electron process layer that obscures breakpoint mapping.

1. Install FlowGuard repo-scoped into the playground and enable debug logging
   (sections 11 and 12).
2. Verify the host and plugin discovery:

   ```bash
   opencode --version
   opencode debug paths
   opencode plugin list
   ```

3. Reproduce the host behavior with the native CLI. Start a private server with
   `opencode serve --port 4096` when you need a separate server, or use the
   normal TUI/CLI flow when the defect is in the user-facing path.
4. For a FlowGuard TypeScript breakpoint, run the owning Vitest unit or
   integration test. The published tarball contains only `dist/` and `VERSION`,
   so breakpoints in an installed copy bind to generated JavaScript, not
   `src/**/*.ts`.
5. For the installed-plugin path, inspect the generated wrapper and dist files:

   ```text
   <playground>/.opencode/plugins/flowguard/index.ts
   <playground>/.opencode/node_modules/@flowguard/core/dist/integration/plugin.js
   ```

6. Observe native setup, reload, and cleanup. `/start` is the native activation
   command; do not use `/hydrate` as an activation substitute. A `/start`
   callback is not operator provenance. Installed INACTIVE parity remains
   `NOT_VERIFIED` unless the owning host-probe or acceptance record proves it.

FlowGuard TypeScript-level breakpoints are not available for an installed copy.
Reproduce the logic through Vitest first; that is the canonical path.

### 16.3 Debugging OpenCode itself

Only for defects inside the host. FlowGuard deliberately maintains no second V2
host debug pipeline. Use the upstream OpenCode contributor workflow for the exact
V2 source revision and record the version under test.

Source-level Bun inspector commands are not part of this guide's verified V2
baseline. Do not copy the removed V1 source-checkout workflow into a current
session. If source-level host debugging is required, treat it as
`NOT_VERIFIED` for this repository until a pinned V2 source revision and inspect
command are recorded. The verified FlowGuard diagnostic path remains
`opencode debug ...`, the host logs, and Vitest.

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
[ ] FlowGuard - CLI Doctor stops in TypeScript source (source-repo failure path)
[ ] Playground doctor stops in TypeScript source (installed-product path)
[ ] FlowGuard - MCP Server stops in TypeScript source (startup/registration)
[ ] Client-launched MCP request breakpoint is hit (Inspector or configured client)
[ ] Source-map mapping resolves dist/*.js → src/*.ts
[ ] Dogfood tarball builds
[ ] Repo-scoped playground install succeeds
[ ] flowguard doctor succeeds in playground
[ ] opencode --version reports the recorded V2 CLI candidate
[ ] opencode debug paths, debug config, and plugin list succeed
[ ] Repo-scoped FlowGuard is present in opencode plugin list
[ ] /reload rediscovers the installation; /start reaches FlowGuard
[ ] Installed dist breakpoint or structured host log proves plugin setup/reload
[ ] debug logging appears in the documented location
[ ] Installed INACTIVE parity remains NOT_VERIFIED unless a host-probe record proves it
```
