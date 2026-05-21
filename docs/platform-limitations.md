# Platform Limitations

FlowGuard's governance model was designed for in-process enforcement within the OpenCode plugin SDK. When running on out-of-process hook platforms (Claude Code, Codex), certain architectural gaps exist due to fundamental platform constraints.

This document enumerates each gap with its impact assessment, mitigation strategy, and residual risk classification.

## Gap Summary

| #   | Gap                                   | Impact | Residual Risk                      | Affected Platforms |
| --- | ------------------------------------- | ------ | ---------------------------------- | ------------------ |
| 1   | No Tool Argument Mutation             | LOW    | LOW                                | Claude Code, Codex |
| 2   | Hook Latency (Process Spawn)          | MEDIUM | LOW (Claude Code) / MEDIUM (Codex) | Codex              |
| 3   | Hook Timeout = Tool Proceeds          | HIGH   | HIGH                               | Claude Code, Codex |
| 4   | Subagent Orchestration is LLM-Driven  | MEDIUM | MEDIUM                             | Claude Code, Codex |
| 5   | No Session Compaction Context (Codex) | LOW    | LOW                                | Codex              |
| 6   | Codex Cloud Sandbox Deployment        | LOW    | LOW                                | Codex Cloud        |

## Enforcement Levels

FlowGuard operates at different enforcement levels depending on the host platform:

| Level         | Platform            | Guarantee                                                                                       |
| ------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `synchronous` | OpenCode Plugin SDK | In-process enforcement. Tool call blocked synchronously before execution. Full fail-closed.     |
| `hook_gated`  | Claude Code, Codex  | Out-of-process hook evaluation. Best-effort fail-closed — platform may proceed on hook failure. |
| `advisory`    | Any (MCP-only)      | Governance decisions returned as tool output. LLM must comply voluntarily.                      |

---

## Gap 1: No Tool Argument Mutation

**Impact**: LOW

**Description**: FlowGuard's OpenCode plugin strips null-valued args from tool inputs (DeepSeek R1 compatibility fix). On out-of-process platforms, PreToolUse hooks cannot modify tool arguments before execution.

**Platform behavior**:

- Claude Code `PreToolUse`: `updatedInput` field documented as "not yet supported"
- Codex `PreToolUse`: No input mutation capability

**Mitigation implemented**:

- Arg sanitization moved to the MCP server layer (`src/mcp-server/tool-adapter.ts`)
- When the LLM calls FlowGuard MCP tools, null args are stripped before processing
- For host tools (Bash, Edit): null args do not cause failures on Claude/Codex models

**Code reference**: `src/mcp-server/tool-adapter.ts:sanitizeNullArgs()`

**Residual Risk**: LOW — The null arg issue is model-specific (DeepSeek R1) and does not manifest on Claude or Codex-supported models.

---

## Gap 2: Hook Latency (Process Spawn Overhead)

**Impact**: MEDIUM

**Description**: Each PreToolUse hook invocation in command mode spawns a new Node.js process (~100-200ms overhead). This adds latency to every tool call.

**Platform behavior**:

- Claude Code: Supports `"type": "http"` hooks (persistent server, ~5-20ms latency)
- Codex: Only `"type": "command"` hooks (no HTTP hook support)

**Mitigation implemented**:

1. **Claude Code**: Persistent HTTP hook server (`src/hooks/http-server.ts`) listens on `localhost:18462`. Sub-20ms response time. Configure via `"type": "http"` in `hooks.json`.
2. **Codex**: Command hooks optimized for fast startup (minimal imports, single-file entry points, no dynamic require).
3. **Both**: Session state cached in memory within HTTP server mode.

**Code references**:

- `src/hooks/http-server.ts` (351 LOC, persistent server)
- `src/hooks/pre-tool-use.ts` (114 LOC, fast-path command hook)

**Residual Risk**:

- Claude Code: LOW (HTTP hooks eliminate spawn overhead)
- Codex: MEDIUM (~150-200ms added per tool call, unavoidable with command hooks)

---

## Gap 3: Hook Timeout = Tool Proceeds

**Impact**: HIGH

**Description**: Both Claude Code and Codex allow tool execution to proceed if a PreToolUse hook times out or crashes. This violates strict fail-closed semantics.

**Platform behavior**:

- Claude Code: Hook timeout → non-blocking error, execution continues
- Codex: Hook timeout → tool proceeds

**Mitigation implemented**:

1. **Aggressive timeouts**: PreToolUse hooks configured with 10s timeout (vs 600s platform default). Fast failure rather than hanging.
2. **Fast execution**: Hook scripts complete in <50ms (command) or <20ms (HTTP). Timeout risk minimized.
3. **Audit trail**: All hook decisions (allow/deny) are persisted to the audit trail. Timeout events are detectable post-hoc.
4. **HTTP health monitoring**: Claude Code HTTP hooks include `/health` endpoint for liveness verification.
5. **Fail-closed on internal error**: Hook scripts catch all exceptions and emit deny — crashes produce explicit denials, not silent pass-through.

**Code references**:

- `src/templates/claude-code-plugin.ts` (timeout: 10000ms)
- `src/templates/codex-plugin.ts` (timeout: 10000ms)
- `src/hooks/http-server.ts:316-330` (fail-closed on handler error)

**Residual Risk**: HIGH — This is a fundamental platform limitation. If the hook process is killed by the OS (OOM, SIGKILL) or the HTTP server crashes without restart, the platform will allow tool execution without governance. This is documented as "best-effort fail-closed" for out-of-process platforms.

**Recommendation for critical deployments**: Use Claude Code with HTTP hooks and external process monitoring (systemd, Docker health checks) to restart the hook server on failure.

---

## Gap 4: Subagent Orchestration is LLM-Driven

**Impact**: MEDIUM

**Description**: Hooks cannot synchronously spawn subagents. The review flow depends on the LLM correctly following instructions to invoke the reviewer.

**Platform behavior**:

- Claude Code: Hooks cannot spawn tasks; LLM must invoke reviewer via tool call
- Codex: Hooks cannot spawn subagents; LLM must follow AGENTS.md instructions

**Mitigation implemented**:

1. **Explicit instructions**: FlowGuard tools return unambiguous instructions for LLM to invoke the reviewer.
2. **Gate enforcement**: PreToolUse hook blocks ALL mutating tools until review evidence exists on disk.
3. **Escalating warnings**: PostToolUse hook surfaces time-based escalating warnings when review obligations remain pending (info → warn → critical).
4. **Manual fallback**: `flowguard_decision` tool allows human to approve directly, bypassing automated review.
5. **Defense-in-depth**: `isSubagentAuthorized()` blocks unauthorized subagent types.

**Code references**:

- `src/hooks/shared/obligation-tracker.ts` (escalation logic)
- `src/hooks/post-tool-use.ts:80-87` (escalation integration)
- `src/hooks/shared/phase-gate.ts:isSubagentAuthorized()` (defense-in-depth)

**Residual Risk**: MEDIUM — LLM may ignore reviewer instructions. Gate enforcement prevents bypass (mutating tools blocked) but may cause session stall if LLM does not comply.

---

## Gap 5: No Session Compaction Context in Codex

**Impact**: LOW

**Description**: When the context window is compacted, FlowGuard cannot inject governance state summary on Codex. LLM may lose awareness of current phase/constraints.

**Platform behavior**:

- Claude Code: Has `PreCompact`/`PostCompact` hooks — can inject context
- Codex: No compaction hooks

**Mitigation implemented**:

1. **Self-documenting tool output**: All 12 FlowGuard MCP tools return `phase` in their response. Governance state is embedded in every tool interaction.
2. **AGENTS.md instructions**: Document `flowguard_status` as the re-orientation command after compaction.
3. **Status tool**: `flowguard_status` returns comprehensive governance state (phase, policy mode, obligations, completeness matrix).

**Code references**:

- All tool implementations in `src/integration/tools/` include `phase` in output
- `src/integration/tools/status-tool.ts` (full governance projection)

**Residual Risk**: LOW — Self-documenting output ensures governance context is available in every tool response. Post-compaction re-orientation may require one extra `flowguard_status` call.

---

## Gap 6: Codex Cloud Sandbox Deployment

**Impact**: LOW

**Description**: Codex cloud tasks run in isolated containers with no internet access. FlowGuard must be pre-installed.

**Platform behavior**:

- Codex cloud: Environment setup script runs before task; can install tools
- Codex local: Normal filesystem access, plugin loaded directly

**Mitigation implemented**:

1. **Setup script**: `scripts/codex-cloud-setup.sh` installs FlowGuard in Codex containers.
2. **Multiple install sources**: npm package → GitHub release tarball (fallback).
3. **MCP configuration**: Script auto-configures `.codex/mcp.json`.
4. **Verification**: Script verifies installation before task begins.

**Code reference**: `scripts/codex-cloud-setup.sh`

**Residual Risk**: LOW — Standard Codex cloud deployment pattern. Requires Node.js >= 20 (available in Codex containers).

---

## Risk Acceptance Matrix

| Residual Risk | Acceptance Criteria                         | Monitoring                                                         |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| LOW           | Acceptable for all deployments              | Standard audit trail review                                        |
| MEDIUM        | Acceptable with documented awareness        | Audit trail + obligation escalation warnings                       |
| HIGH (Gap 3)  | Requires explicit organizational acceptance | External process monitoring, health checks, incident response plan |

## References

- `src/adapters/host-adapter.ts` — Host-Agnostic Adapter Interface (HAI)
- `src/hooks/http-server.ts` — HTTP hook server for Claude Code
- `src/hooks/shared/obligation-tracker.ts` — Review obligation escalation
- `src/mcp-server/tool-adapter.ts` — MCP layer arg sanitization
- `scripts/codex-cloud-setup.sh` — Codex cloud installation
