# Multi-Platform Deployment Guide

FlowGuard supports three host platforms with different integration mechanisms.
This guide covers installation and configuration for each. OpenCode is the
strongest synchronous-enforcement host; Claude Code and Codex are hook-gated
and platform-limited (see `docs/platform-limitations.md` for the boundary
conditions).

## Platform Comparison

| Capability        | OpenCode Plugin | Claude Code                 | Codex        |
| ----------------- | --------------- | --------------------------- | ------------ |
| Enforcement Level | `synchronous`   | `hook_gated`                | `hook_gated` |
| Hook Transport    | In-process      | HTTP or Command             | Command      |
| Arg Mutation      | Yes             | No                          | No           |
| Context Injection | Yes             | Yes (PreCompact)            | No           |
| Reviewer Spawn    | SDK-native      | LLM-driven                  | LLM-driven   |
| Latency           | <1ms            | <20ms (HTTP) / ~150ms (cmd) | ~150ms       |

## Distribution Reality

FlowGuard is **not** published to the npm registry and does **not** ship as
an OpenCode plugin-registry entry. The only supported install source is a
GitHub Release tarball named `flowguard-core-{version}.tgz`, consumed by the
`flowguard install` CLI. See `docs/distribution-model.md` for the full
contract. All install commands in this guide use that tarball-driven flow.

## OpenCode Plugin (Primary)

### Installation

Download `flowguard-core-{version}.tgz` (and `checksums.sha256`) from
the [GitHub Releases page](https://github.com/koeppben23/governed-runtime/releases),
then run:

```bash
# Install FlowGuard into the global OpenCode user-config
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz \
  --install-scope global \
  --force
```

The installer writes the OpenCode plugin, custom tools, command prompts,
reviewer agent, and managed mandates under `~/.config/opencode/`. For a
repo-scoped install (committed to version control) replace
`--install-scope global` with `--install-scope repo`.

### Configuration

No additional configuration is needed — OpenCode loads the installed plugin
automatically. Hooks register in-process on plugin load; no separate hook
server is required.

### Verification

```bash
# FlowGuard's own doctor reports the installed assets and computed config.
flowguard doctor --install-scope global
```

Expected output (truncated):

```
  [ok] ~/.config/opencode/flowguard-mandates.md
  [ok] ~/.config/opencode/plugins/flowguard-audit.ts
  [ok] ~/.config/opencode/tools/flowguard.ts
  [ok] ~/.config/opencode/agents/flowguard-reviewer.md
  [ok] ~/.config/opencode/commands/hydrate.md
  ... (20 command files — 12 canonical + 8 product aliases)
  [ok] ~/.config/opencode/package.json
  [ok] ~/.config/opencode/opencode.json (or opencode.jsonc when present)
  [ok] flowguard.json — config valid
  N/N checks passed
```

OpenCode's own `opencode doctor` does not emit a FlowGuard-specific status
line — rely on `flowguard doctor` for FlowGuard-side verification.

---

## Claude Code

Claude Code reads `.claude/hooks.json` and `.claude/mcp.json` from the
workspace root. After installing FlowGuard via the OpenCode-global install
above (which puts the `flowguard-hook-*` binaries on PATH), wire the hooks
and MCP server using the installed binary names — **not** ad-hoc
`node dist/hooks/...` paths.

### Option A: HTTP Hooks (Recommended)

HTTP hooks provide sub-20ms latency via a persistent server process.

#### 1. Start the hook server

```bash
# Generate once per local deployment. Keep the token in the environment inherited
# by both Claude Code and the HTTP hook server; never commit it to hooks.json.
export FLOWGUARD_HOOK_TOKEN="$(openssl rand -hex 32)"

# Start the FlowGuard HTTP hook server (background).
flowguard-hook-server &

# Or with a custom port:
FLOWGUARD_HOOK_PORT=18462 flowguard-hook-server &

# Verify:
curl http://127.0.0.1:18462/health
# → {"status":"ok"}
```

`FLOWGUARD_HOOK_TOKEN` is mandatory, must contain at least 32 non-whitespace
characters, and is never logged by FlowGuard. Start Claude Code from the same
shell or service environment so it inherits this variable. The HTTP hook
configuration expands it only when it is listed in `allowedEnvVars` below.

The listener binds to `127.0.0.1` by default (`FLOWGUARD_HOOK_HOST`). Only
`127.0.0.1` and `::1` are accepted without explicit remote opt-in. Remote
binding requires `FLOWGUARD_HOOK_ALLOW_REMOTE=1` as well as the token. It does
not add TLS: use remote HTTP only behind a trusted network boundary or a
TLS-terminating reverse proxy, because bearer tokens sent over HTTP can be
observed on the network.

#### 2. Configure hooks.json

Place in `.claude/hooks.json` at workspace root:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/pre-tool-use",
        "headers": { "Authorization": "Bearer ${FLOWGUARD_HOOK_TOKEN}" },
        "allowedEnvVars": ["FLOWGUARD_HOOK_TOKEN"],
        "matcher": "Bash|Edit|Write",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/post-tool-use",
        "headers": { "Authorization": "Bearer ${FLOWGUARD_HOOK_TOKEN}" },
        "allowedEnvVars": ["FLOWGUARD_HOOK_TOKEN"],
        "matcher": "Bash|Edit|Write|mcp__flowguard__.*",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/session-start",
        "headers": { "Authorization": "Bearer ${FLOWGUARD_HOOK_TOKEN}" },
        "allowedEnvVars": ["FLOWGUARD_HOOK_TOKEN"],
        "matcher": "startup"
      }
    ],
    "Stop": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/stop",
        "headers": { "Authorization": "Bearer ${FLOWGUARD_HOOK_TOKEN}" },
        "allowedEnvVars": ["FLOWGUARD_HOOK_TOKEN"],
        "timeout": 15000
      }
    ]
  }
}
```

#### 3. Configure MCP server

Place in `.claude/mcp.json`:

```json
{
  "mcpServers": {
    "flowguard": {
      "command": "flowguard-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

### Option B: Command Hooks

Command hooks spawn a new process per invocation (~150ms latency). They use
the same installed `flowguard-hook-*` binaries — no need for `dist/hooks/...`
paths.

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "flowguard-hook-pre",
        "matcher": "Bash|Edit|Write",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "flowguard-hook-post",
        "matcher": "Bash|Edit|Write|mcp__flowguard__.*",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "flowguard-hook-session",
        "matcher": "startup"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "flowguard-hook-stop",
        "timeout": 15000
      }
    ]
  }
}
```

### Verification

```bash
# Test hook server health (HTTP mode)
curl -s http://127.0.0.1:18462/health | jq .

# Test pre-tool-use deny (investigation phase)
echo '{"tool_name":"Bash","tool_input":{"command":"rm -rf /"},"session_id":"test","cwd":"/project"}' \
  | curl -s -X POST http://127.0.0.1:18462/hooks/pre-tool-use \
      -H "Authorization: Bearer ${FLOWGUARD_HOOK_TOKEN}" \
      -H 'Content-Type: application/json' --data-binary @-

# Test MCP server
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | flowguard-mcp
```

---

## Codex (Local)

### Installation

Same tarball-driven install flow as OpenCode. The installer also seeds the
Codex host integration when `--host codex` is selected:

```bash
npx --package ./flowguard-core-{version}.tgz flowguard install \
  --core-tarball ./flowguard-core-{version}.tgz \
  --host codex \
  --install-scope global \
  --force
```

`npm install -g flowguard` is **not** supported — there is no `flowguard`
package on the public npm registry.

### Configuration

#### hooks.json

Place in `.codex/hooks.json` at workspace root. Use the installed
`flowguard-hook-*` binaries (no `dist/...` paths):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "flowguard-hook-pre",
        "matcher": "^Bash$|^apply_patch$",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "flowguard-hook-post",
        "matcher": "^Bash$|^apply_patch$|^mcp__flowguard__.*$",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "flowguard-hook-session",
        "matcher": "startup|resume|clear"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "flowguard-hook-stop",
        "timeout": 15000
      }
    ]
  }
}
```

#### MCP Server

Place in `.codex/mcp.json`:

```json
{
  "mcpServers": {
    "flowguard": {
      "command": "flowguard-mcp",
      "args": [],
      "env": {}
    }
  }
}
```

### Verification

```bash
# Confirm the FlowGuard MCP binary is resolvable
which flowguard-mcp

# Confirm the installed CLI version via doctor / the shipped VERSION file
flowguard doctor --install-scope global
# Or, without running the CLI:
cat "$(npm root -g)/@flowguard/core/VERSION"

# Test phase gate (should deny in investigation phases)
echo '{"tool_name":"Bash","tool_input":{},"session_id":"s","cwd":"/project"}' \
  | flowguard-hook-pre
```

Codex runtime support is **NOT_VERIFIED** end-to-end in CI. See
`docs/platform-limitations.md` Gap 7 for the current scope of verified Codex
behavior.

---

## Codex (Cloud)

Codex cloud tasks run in isolated containers. FlowGuard must be pre-installed
via the environment setup script.

### Setup

```bash
# In your Codex cloud environment setup:
FLOWGUARD_VERSION=1.2.0-tp.1 bash scripts/codex-cloud-setup.sh
```

The script downloads `flowguard-core-${FLOWGUARD_VERSION}.tgz` (and
`checksums.sha256`) from GitHub Releases, installs it into
`FLOWGUARD_DIR`, symlinks the `flowguard*` and `flowguard-hook-*` binaries
into `FLOWGUARD_BIN`, and runs `flowguard install --host codex` to wire host
config. Pass `FLOWGUARD_TARBALL=/path/to/local.tgz` to skip the download for
fully air-gapped images.

### Environment Variables

| Variable                      | Default                       | Description                                                                                  |
| ----------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------- |
| `FLOWGUARD_VERSION`           | (required if no tarball)      | Release tag to install (e.g. `1.2.0-tp.1`)                                                   |
| `FLOWGUARD_TARBALL`           | (unset)                       | Local path or URL to a pre-staged tarball; overrides `FLOWGUARD_VERSION`                     |
| `FLOWGUARD_REPO`              | `koeppben23/governed-runtime` | GitHub repo to download from                                                                 |
| `FLOWGUARD_DIR`               | `/usr/local/lib/flowguard`    | Installation directory                                                                       |
| `FLOWGUARD_BIN`               | `/usr/local/bin`              | Binary symlink location                                                                      |
| `FLOWGUARD_SKIP_INSTALL_HOST` | `0`                           | If `1`, skip `flowguard install --host codex` (use when host config is mounted from outside) |

### Requirements

- Node.js >= 20 (pre-installed in Codex containers)
- `curl` (pre-installed in Codex containers)
- Write access to `FLOWGUARD_DIR` and `FLOWGUARD_BIN`
- Network access to GitHub Releases during setup, unless `FLOWGUARD_TARBALL` is
  set to a pre-staged path

### Verification

The setup script runs verification automatically (presence of all installed
binaries and a `flowguard doctor` run when host wiring is enabled). Manual
re-check:

```bash
which flowguard-mcp
flowguard doctor --install-scope global
cat .codex/mcp.json
```

---

## Environment Variables (All Platforms)

| Variable                      | Default     | Description                                                                                           |
| ----------------------------- | ----------- | ----------------------------------------------------------------------------------------------------- |
| `FLOWGUARD_HOOK_PORT`         | `18462`     | HTTP hook server port (Claude Code)                                                                   |
| `FLOWGUARD_HOOK_HOST`         | `127.0.0.1` | HTTP hook server bind address                                                                         |
| `FLOWGUARD_HOOK_TOKEN`        | Required    | Bearer token for all HTTP governance routes; never commit or log it                                   |
| `FLOWGUARD_HOOK_ALLOW_REMOTE` | Unset       | Set exactly to `1` to permit a non-loopback HTTP bind; does not enable TLS                            |
| `FLOWGUARD_SESSION_DIR`       | (none)      | Explicit session directory override; consumed by both hook scripts and the MCP session resolver       |
| `FLOWGUARD_PROJECT_DIR`       | (none)      | Host-advertised project dir for MCP (Claude Code MCP template sets this from `${CLAUDE_PROJECT_DIR}`) |

> **MCP session resolution is fail-closed.** The MCP server resolves the
> project directory from `FLOWGUARD_SESSION_DIR`, then `FLOWGUARD_PROJECT_DIR`,
> then host-advertised MCP roots — in that order. There is **no `cwd`
> fallback**: if none of these is present, tool calls are denied with
> `SESSION_UNRESOLVABLE`. The Claude Code MCP template sets
> `FLOWGUARD_PROJECT_DIR=${CLAUDE_PROJECT_DIR}` automatically. Hosts that
> advertise neither an env source nor MCP roots (currently the Codex MCP
> template) must set `FLOWGUARD_SESSION_DIR` or `FLOWGUARD_PROJECT_DIR` for
> MCP tool calls to resolve.

`FLOWGUARD_LOG_LEVEL` is **not** consumed by the runtime; the log level is
sourced exclusively from `config.logging.level` (see `docs/configuration.md`).

## Troubleshooting

### Hook not triggering

1. Verify the hook matcher regex matches the tool name.
2. Check the hook timeout is not set too low (minimum: 10000ms recommended).
3. Verify the hook binary is resolvable (`which flowguard-hook-pre`).

### MCP server not connecting

1. Verify `flowguard-mcp` is in `PATH`.
2. Check `.claude/mcp.json` or `.codex/mcp.json` syntax.
3. Test manually: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":1}' | flowguard-mcp`.

### HTTP hook server not responding

1. Check if the process is running: `curl http://127.0.0.1:18462/health`.
2. Check port conflicts: `lsof -i :18462`.
3. Check logs: the server writes to stderr.

### Phase gate denying unexpectedly

1. Run `flowguard_status` via MCP to check the current phase.
2. Verify the session is initialized (`flowguard_hydrate`).
3. Check if the phase allows the tool: investigation phases block mutating tools.
