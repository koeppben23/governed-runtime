# OpenCode v2.2.4 host-enforcement spike

Status: **SUPPORTED in the patched CLI source build**. Stock OpenCode v2.2.4
remains **NOT_SUPPORTED** for the unchanged contract.

This is a bounded experiment against the pinned OpenCode tag `v2.2.4`
(`45898d0f8569225eb1ddb4ee13f8581b34dff311`). FlowGuard production code, the v1
SDK baseline, and `TESTED_OPENCODE_HOST_VERSION` are unchanged. The patch is in
[`opencode-v2.2.4-host-enforcement.patch`](./opencode-v2.2.4-host-enforcement.patch).

## What the patch adds

| Area                    | Host behavior                                                                                                                                                                                                                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Trusted policy          | `requiredPlugins` and `providerExecution` are honored only from managed config documents or the launcher-owned `OPENCODE_HOST_POLICY` file. Workspace and SDK config cannot weaken them.                                                                                                           |
| Required-plugin barrier | `Plugin.requireActive` waits for the current activation, checks live slots, and fails when a required plugin is missing, failed, closed, or retained only as a fallback after a failed reload.                                                                                                     |
| Execution gates         | The barrier runs in `SessionPrompt.prepare`, `SessionCommand.execute` before native command shell interpolation, `SessionGenerate.generate`, `SessionShell.start`, the session runner per step, immediately before the provider request in `SessionStep.attempt`, and before local tool execution. |
| Provider request policy | The final HTTP request body and WebSocket send frame are inspected after plugin request hooks and before the external send. A provider allowlist is enforced; hosted-tool definitions and known hosted calls are rejected.                                                                         |
| Final readiness         | The provider middleware receives the live plugin service and repeats the required-plugin check immediately before `handler`/`sendText`, closing the previous step-to-send TOCTOU window.                                                                                                           |
| MCP                     | `McpTool.flush` settles a just-connected catalog before the session snapshots tools, so a real MCP tool can be advertised and callable. The existing `permission.assert` remains before `mcp.callTool`.                                                                                            |

The provider policy is a **capability gate**, not a retroactive response filter.
A provider that autonomously emits an unoffered hosted call cannot be stopped
after the response arrives; such providers must be excluded by the provider
allowlist or covered by an explicit provider capability contract.

## Evidence

Probe: [`scripts/opencode-v2-probe/probes/p0-host-enforcement.mjs`](../../../../../scripts/opencode-v2-probe/probes/p0-host-enforcement.mjs)

Patched run:

```sh
OPENCODE_CLI=/path/to/patched/opencode \
  node scripts/opencode-v2-probe/probes/p0-host-enforcement.mjs
```

| Case                                                                           | Result                                                                                                               |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| Required plugin active                                                         | active, one provider request                                                                                         |
| Required plugin setup failed, static provider present                          | prompt rejected, zero provider requests, zero hooks                                                                  |
| Native command with `!` shell interpolation, plugin inactive                   | marker absent, zero provider requests                                                                                |
| Native command control                                                         | marker present, one provider request                                                                                 |
| Hosted-tool definition in final request                                        | rejected before provider, zero provider requests                                                                     |
| Allowed control without hosted definition                                      | one provider request                                                                                                 |
| Provider allowlist mismatch                                                    | zero provider requests                                                                                               |
| MCP tool exposed with `codemode: false`, permission deny `mcprobe_echo` / `**` | tool advertised and attempted, MCP server marker absent                                                              |
| MCP allowed control                                                            | tool advertised, MCP server marker present                                                                           |
| Failed plugin reload during a live session                                     | next prompt rejected, zero provider requests                                                                         |
| Plugin file removed during a live session                                      | next prompt rejected, zero provider requests                                                                         |
| Plugin fails inside `http.request` before send (TOCTOU)                        | hook returns, final readiness check blocks, zero provider requests                                                   |
| TOCTOU control                                                                 | one provider request                                                                                                 |
| WebSocket provider, allowed control                                            | one `response.create` frame, answer received                                                                         |
| WebSocket provider, hosted-tool definition                                     | zero WebSocket frames, no provider execution                                                                         |
| Stock OpenCode 2.2.4                                                           | required-plugin, command-shell, hosted-tool, allowlist, reload/removal, TOCTOU, WebSocket-hosted, and MCP cases fail |

Reports:

- [patched report](./report.patched.json)
- [stock report](./report.stock.json)

Relevant source verification:

```sh
cd packages/core
bun test test/session-model-request-hooks.test.ts test/tool-execute.test.ts \
  test/mcp.test.ts test/session-step.test.ts --timeout 30000
# 95 pass, 0 fail

bun run typecheck   # core
bun run --cwd ../server typecheck
bun run --cwd ../cli typecheck
```

All three type checks passed in the source tree. The patched CLI was launched
from a clean temporary project with `OPENCODE_HOST_POLICY` pointing at
[`host-policy.example.json`](./host-policy.example.json).

## Boundaries

- **Desktop: NOT_VERIFIED.** The packaged app resolves
  `resources/opencode-cli` and stages that binary; it does not use this source
  build. Desktop's development script sets `OPENCODE_DESKTOP_CLI_DEV` to
  `packages/cli`, so a dev launch would exercise the patched source, but the GUI
  path was not executed here and the installed app was not modified. A real
  acceptance run must ship the same patch in the Desktop backend or prove an
  equivalent upstream contract.
- **Provider-emitted unoffered calls.** A provider that executes a hosted action
  without an offered definition cannot be stopped by a request gate. The
  provider allowlist is the capability contract; providers without such a
  contract remain outside the guaranteed scope.
- **Patch maintenance.** This is a security build pinned to v2.2.4. Every
  OpenCode update requires revalidation; an upstream contract is preferable.
- **Policy deployment.** The test uses the launcher-owned policy file. A
  production deployment should use managed config or a root-owned launcher
  environment, not a workspace file.

## Reproduction notes

The patched host was run from the cloned source tree without modifying the
installed OpenCode 2.2.4 application. The wrapper keeps the probe project as the
process working directory and uses the OpenCode CLI `bunfig.toml` for the Solid
preload:

```sh
bun --config=/path/to/opencode-v2.2.4-src/packages/cli/bunfig.toml \
  run /path/to/opencode-v2.2.4-src/packages/cli/src/index.ts "$@"
```

`OPENCODE_HOST_POLICY` is read at instance startup. A missing, unreadable, or
malformed policy file is a startup defect; it never degrades to allow.
