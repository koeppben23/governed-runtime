# Security Model: Multi-Platform

This document defines FlowGuard's security model, trust boundaries, and fail-closed guarantees across all supported host platforms.

FlowGuard is filesystem-first and offline-capable by default. Network-dependent
surfaces are explicit: `/review url=...` performs HTTPS content loading when
invoked, remote JWKS uses HTTPS when `identityProvider.mode=jwks` with `jwksUri`
is configured, and Claude Code HTTP hook mode starts a localhost listener when
operators choose that hook transport.

## Trust Boundary Architecture

```
┌─────────────────────────────────────────────────────────────────────┐
│                         HOST PLATFORM                                │
│  (OpenCode / Claude Code / Codex)                                   │
│                                                                     │
│  ┌──────────────┐    ┌──────────────────────────────────────────┐  │
│  │   LLM Agent  │    │           Tool Execution                  │  │
│  │              │────│  Bash, Write, Edit, apply_patch            │  │
│  └──────────────┘    └───────────────┬──────────────────────────┘  │
│                                       │                             │
│  ─ ─ ─ ─ ─ ─ TRUST BOUNDARY ─ ─ ─ ─│─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─   │
│                                       │                             │
│  ┌────────────────────────────────────▼─────────────────────────┐  │
│  │              FLOWGUARD GOVERNANCE LAYER                        │  │
│  │                                                               │  │
│  │  ┌─────────────┐  ┌──────────────┐  ┌────────────────────┐  │  │
│  │  │ PreToolUse  │  │ PostToolUse  │  │  MCP Server        │  │  │
│  │  │ (Gate)      │  │ (Audit)      │  │  (12 Tools)        │  │  │
│  │  └──────┬──────┘  └──────┬───────┘  └─────────┬──────────┘  │  │
│  │         │                 │                     │             │  │
│  │  ┌──────▼─────────────────▼─────────────────────▼──────────┐ │  │
│  │  │           FlowGuard State Machine + Policy               │ │  │
│  │  │  (Deterministic, fail-closed, evidence-backed)           │ │  │
│  │  └──────────────────────────┬───────────────────────────────┘ │  │
│  │                             │                                  │  │
│  │  ┌──────────────────────────▼───────────────────────────────┐ │  │
│  │  │          Persistence Layer (Audit Trail + State)          │ │  │
│  │  └─────────────────────────────────────────────────────────-┘ │  │
│  └───────────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────┘
```

## Enforcement Guarantees by Platform

### OpenCode Plugin (Synchronous)

| Property            | Guarantee                                       |
| ------------------- | ----------------------------------------------- |
| Enforcement timing  | Synchronous, before tool execution              |
| Fail-closed         | **GUARANTEED** — exception in hook blocks tool  |
| Argument mutation   | Supported — null args stripped before tool call |
| Output interception | Supported — tool output can be annotated        |
| State consistency   | Single-process, no race condition possible      |
| Audit completeness  | Every tool call audited (pre + post)            |

### Claude Code (Hook-Gated)

| Property            | Guarantee                                                            |
| ------------------- | -------------------------------------------------------------------- |
| Enforcement timing  | Before tool execution (PreToolUse hook)                              |
| Fail-closed         | **BEST-EFFORT** — hook crash/timeout may allow tool to proceed       |
| Argument mutation   | NOT supported (platform limitation)                                  |
| Output interception | NOT supported (PostToolUse is informational)                         |
| State consistency   | HTTP server: single-process. Command hooks: per-invocation isolation |
| Audit completeness  | Best-effort — audit writes are non-blocking                          |

**Fail-closed implementation**:

- Hook script: catches all exceptions, emits deny on error
- HTTP server: explicit localhost listener for Claude Code HTTP hooks; catches
  handler errors and returns deny on internal failure
- Platform override: if hook process is killed (OOM/SIGKILL), platform proceeds without governance

### Codex (Hook-Gated)

| Property            | Guarantee                                         |
| ------------------- | ------------------------------------------------- |
| Enforcement timing  | Before tool execution (PreToolUse hook)           |
| Fail-closed         | **BEST-EFFORT** — same limitations as Claude Code |
| Argument mutation   | NOT supported (platform limitation)               |
| Output interception | NOT supported                                     |
| State consistency   | Per-invocation isolation (new process per hook)   |
| Audit completeness  | Best-effort                                       |

**Additional Codex-specific constraints**:

- No HTTP hook support (command hooks only)
- No compaction hooks (context loss possible on long sessions)
- Cloud sandbox: requires pre-installation

## Fail-Closed Behavior Matrix

| Failure Scenario      | OpenCode                    | Claude Code (HTTP)           | Claude Code (cmd)             | Codex                         |
| --------------------- | --------------------------- | ---------------------------- | ----------------------------- | ----------------------------- |
| Hook throws exception | Tool BLOCKED                | Tool BLOCKED (deny returned) | Tool BLOCKED (deny on stdout) | Tool BLOCKED (deny on stdout) |
| Hook timeout (10s)    | N/A (sync)                  | Tool PROCEEDS\*              | Tool PROCEEDS\*               | Tool PROCEEDS\*               |
| Hook process killed   | N/A (in-proc)               | Tool PROCEEDS\*              | Tool PROCEEDS\*               | Tool PROCEEDS\*               |
| State file missing    | Tool BLOCKED                | Tool BLOCKED (deny)          | Tool BLOCKED (deny)           | Tool BLOCKED (deny)           |
| State file corrupt    | Tool BLOCKED                | Tool BLOCKED (deny)          | Tool BLOCKED (deny)           | Tool BLOCKED (deny)           |
| Audit write fails     | Tool ALLOWED (non-blocking) | Tool ALLOWED                 | Tool ALLOWED                  | Tool ALLOWED                  |
| Deny stdout fails     | N/A                         | N/A                          | Hook exits non-zero\*\*       | Hook exits non-zero\*\*       |

`*` = Platform limitation. FlowGuard cannot prevent this. See Gap 3 in `platform-limitations.md`.

`**` = FlowGuard treats deny-output failure as fatal and exits non-zero after a
best-effort stderr fallback. Host-level fail-closed behavior is NOT_VERIFIED for
hosts that interpret non-zero exit or missing stdout as allow.

## Defense-in-Depth Layers

FlowGuard implements multiple defense layers. If one fails, subsequent layers provide partial protection:

### Layer 1: PreToolUse Gate (Primary)

- Blocks mutating tools during investigation phases (synchronous only on OpenCode; best-effort on hook-gated hosts)
- Blocks unauthorized subagent types
- Fail-closed on any internal error

### Layer 2: PostToolUse Audit (Detection)

- Records every tool execution to audit trail
- Surfaces escalating warnings for pending review obligations
- Enables post-hoc detection of ungoverned execution

### Layer 3: MCP Tool Output (Guidance)

- All FlowGuard tools return current phase in output
- Self-documenting: LLM always has governance context
- `flowguard_status` provides full state projection

### Layer 4: Phase-Tool Gate Logic (Canonical Authority)

- Single canonical implementation: `src/integration/phase-tool-gate.ts`
- Used by all enforcement paths (plugin, command hooks, HTTP hooks)
- No duplicate authority — one decision function, multiple invocation paths

### Layer 5: Review Obligation Enforcement

- Pending obligations block mutating tools until fulfilled
- Escalating warnings surface after 60s/180s of non-compliance
- Manual fallback via `flowguard_decision` tool

## Threat Model

### Threats Mitigated

| Threat                         | Mitigation                                                                              |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| LLM writes code without review | Phase gate blocks mutating tools until review obligation fulfilled                      |
| LLM bypasses reviewer          | `isSubagentAuthorized()` blocks unauthorized subagent types                             |
| LLM ignores governance         | Tools return explicit phase/constraints; gate enforcement independent of LLM compliance |
| Audit trail tampering          | Append-only JSONL with hash chain                                                       |
| Session state corruption       | Zod validation on read; fail-closed on invalid state                                    |

### Threats NOT Fully Mitigated (Platform Limitations)

| Threat                                     | Platform           | Residual Risk                                     |
| ------------------------------------------ | ------------------ | ------------------------------------------------- |
| Hook timeout → ungoverned execution        | Claude Code, Codex | HIGH — platform proceeds if hook fails to respond |
| Hook process killed → ungoverned execution | Claude Code, Codex | HIGH — OS-level failure bypasses all governance   |
| LLM ignores reviewer instruction           | All out-of-process | MEDIUM — gate blocks but session may stall        |
| Context loss after compaction              | Codex              | LOW — self-documenting output mitigates           |

## Recommendations by Deployment Criticality

### Standard Development (Low Risk)

- Any platform with default configuration
- Command hooks sufficient
- Standard audit review cadence

### Regulated Development (Medium Risk)

- Claude Code with HTTP hooks (recommended)
- External monitoring of hook server process
- Regular audit trail review
- Obligation escalation alerting configured

### Critical/Compliance Deployments (High Risk)

- OpenCode plugin (synchronous enforcement) strongly recommended
- If out-of-process required: Claude Code HTTP hooks with:
  - systemd/Docker process supervision for hook server
  - Health check monitoring with alerting
  - Automated restart on failure
  - Periodic audit trail integrity verification
- Documented risk acceptance for Gap 3 (hook timeout = tool proceeds)
- Incident response plan for governance bypass detection

## Audit Trail Structure

All enforcement decisions are persisted regardless of platform:

```json
{
  "id": "uuid",
  "sessionId": "...",
  "phase": "PLAN",
  "event": "tool_call",
  "timestamp": "ISO",
  "actor": "machine",
  "detail": {
    "tool": "Bash",
    "hookSource": "http_hook",
    "platform": "claude-code"
  },
  "enforcementLevel": "hook_gated"
}
```

Fields relevant to security analysis:

- `enforcementLevel`: `synchronous` | `hook_gated` | `advisory`
- `detail.hookSource`: `plugin` | `command_hook` | `http_hook`
- `detail.platform`: `opencode` | `claude-code` | `codex`

## References

- [Platform Limitations](./platform-limitations.md) — Detailed gap analysis
- [Multi-Platform Deployment](./multi-platform-deployment.md) — Installation guide
- `src/adapters/host-adapter.ts` — Host-Agnostic Adapter Interface
- `src/hooks/http-server.ts` — HTTP hook server
- `src/integration/phase-tool-gate.ts` — Canonical gate logic
