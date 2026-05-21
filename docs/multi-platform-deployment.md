# Multi-Platform Deployment Guide

FlowGuard supports three host platforms with different integration mechanisms. This guide covers installation and configuration for each.

## Platform Comparison

| Capability        | OpenCode Plugin | Claude Code                 | Codex        |
| ----------------- | --------------- | --------------------------- | ------------ |
| Enforcement Level | `synchronous`   | `hook_gated`                | `hook_gated` |
| Hook Transport    | In-process      | HTTP or Command             | Command      |
| Arg Mutation      | Yes             | No                          | No           |
| Context Injection | Yes             | Yes (PreCompact)            | No           |
| Reviewer Spawn    | SDK-native      | LLM-driven                  | LLM-driven   |
| Latency           | <1ms            | <20ms (HTTP) / ~150ms (cmd) | ~150ms       |

## OpenCode Plugin (Primary)

### Installation

```bash
# Via OpenCode plugin system
opencode plugin install flowguard
```

### Configuration

FlowGuard registers as an OpenCode plugin via `@opencode-ai/plugin`. No additional configuration needed — hooks are registered in-process.

### Verification

```bash
opencode doctor
# Should show: FlowGuard governance: active
```

---

## Claude Code

### Option A: HTTP Hooks (Recommended)

HTTP hooks provide sub-20ms latency via a persistent server process.

#### 1. Start the hook server

```bash
# Start FlowGuard HTTP hook server (background)
node dist/hooks/http-server.js &

# Or with custom port:
FLOWGUARD_HOOK_PORT=18462 node dist/hooks/http-server.js &

# Verify:
curl http://127.0.0.1:18462/health
# → {"status":"ok","port":18462,"pid":...}
```

#### 2. Configure hooks.json

Place in `.claude/hooks.json` at workspace root:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/pre-tool-use",
        "matcher": "Bash|Edit|Write",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/post-tool-use",
        "matcher": "Bash|Edit|Write|mcp__flowguard__.*",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/session-start",
        "matcher": "startup"
      }
    ],
    "Stop": [
      {
        "type": "http",
        "url": "http://127.0.0.1:18462/hooks/stop",
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

Command hooks spawn a new process per invocation (~150ms latency).

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "node dist/hooks/pre-tool-use.js",
        "matcher": "Bash|Edit|Write",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "node dist/hooks/post-tool-use.js",
        "matcher": "Bash|Edit|Write|mcp__flowguard__.*",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "node dist/hooks/session-start.js",
        "matcher": "startup"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node dist/hooks/stop.js",
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
  | curl -s -X POST http://127.0.0.1:18462/hooks/pre-tool-use -d @-

# Test MCP server
echo '{"jsonrpc":"2.0","method":"tools/list","id":1}' | flowguard-mcp
```

---

## Codex (Local)

### Installation

```bash
# Install FlowGuard
npm install -g flowguard

# Or from source:
npm run build && npm link
```

### Configuration

#### hooks.json

Place in `.codex/hooks.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "type": "command",
        "command": "node dist/hooks/pre-tool-use.js",
        "matcher": "^Bash$|^apply_patch$",
        "timeout": 10000
      }
    ],
    "PostToolUse": [
      {
        "type": "command",
        "command": "node dist/hooks/post-tool-use.js",
        "matcher": "^Bash$|^apply_patch$|^mcp__flowguard__.*$",
        "timeout": 30000
      }
    ],
    "SessionStart": [
      {
        "type": "command",
        "command": "node dist/hooks/session-start.js",
        "matcher": "startup|resume|clear"
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node dist/hooks/stop.js",
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
# Verify MCP server binary
flowguard-mcp --version

# Test phase gate (should deny in investigation phases)
echo '{"tool_name":"Bash","tool_input":{},"session_id":"s","cwd":"/project"}' \
  | node dist/hooks/pre-tool-use.js
```

---

## Codex (Cloud)

Codex cloud tasks run in isolated containers. FlowGuard must be pre-installed via the environment setup script.

### Setup

```bash
# In your Codex cloud environment setup:
bash scripts/codex-cloud-setup.sh
```

### Environment Variables

| Variable            | Default                    | Description             |
| ------------------- | -------------------------- | ----------------------- |
| `FLOWGUARD_VERSION` | `latest`                   | Version to install      |
| `FLOWGUARD_DIR`     | `/usr/local/lib/flowguard` | Installation directory  |
| `FLOWGUARD_BIN`     | `/usr/local/bin`           | Binary symlink location |

### Requirements

- Node.js >= 20 (pre-installed in Codex containers)
- Write access to installation directories
- Network access during setup (or pre-seeded npm cache)

### Verification

The setup script runs verification automatically. Manual check:

```bash
which flowguard-mcp
flowguard-mcp --version
cat .codex/mcp.json
```

---

## Environment Variables (All Platforms)

| Variable                | Default     | Description                            |
| ----------------------- | ----------- | -------------------------------------- |
| `FLOWGUARD_HOOK_PORT`   | `18462`     | HTTP hook server port (Claude Code)    |
| `FLOWGUARD_HOOK_HOST`   | `127.0.0.1` | HTTP hook server bind address          |
| `FLOWGUARD_SESSION_DIR` | (computed)  | Override session directory for testing |
| `FLOWGUARD_LOG_LEVEL`   | `info`      | Hook script log verbosity              |

## Troubleshooting

### Hook not triggering

1. Verify hook matcher regex matches the tool name
2. Check hook timeout is not set too low (minimum: 10000ms recommended)
3. Verify hook script path is correct and executable

### MCP server not connecting

1. Verify `flowguard-mcp` is in PATH
2. Check `.claude/mcp.json` or `.codex/mcp.json` syntax
3. Test manually: `echo '{"jsonrpc":"2.0","method":"initialize","params":{"capabilities":{}},"id":1}' | flowguard-mcp`

### HTTP hook server not responding

1. Check if process is running: `curl http://127.0.0.1:18462/health`
2. Check port conflicts: `lsof -i :18462`
3. Check logs: server writes to stderr

### Phase gate denying unexpectedly

1. Run `flowguard_status` via MCP to check current phase
2. Verify session is initialized (`flowguard_hydrate`)
3. Check if phase allows the tool: investigation phases block mutating tools
