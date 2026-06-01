# Platform Limitations

FlowGuard's governance model was designed for in-process enforcement within the OpenCode plugin SDK. When running on out-of-process hook platforms (Claude Code, Codex), certain architectural gaps exist due to fundamental platform constraints.

This document enumerates each gap with its impact assessment, mitigation strategy, and residual risk classification.

## Gap Summary

| #   | Gap                                                                | Impact | Residual Risk                  | Affected Platforms |
| --- | ------------------------------------------------------------------ | ------ | ------------------------------ | ------------------ |
| 1   | Tool Argument Mutation Is Host-Limited                             | LOW    | LOW                            | Claude Code, Codex |
| 2   | Hook Latency (Process Spawn)                                       | MEDIUM | MEDIUM (default command hooks) | Claude Code, Codex |
| 3   | Hook Timeout = Tool Proceeds                                       | HIGH   | HIGH                           | Claude Code, Codex |
| 4   | Subagent Orchestration Has No OpenCode-Equivalent Plugin Handshake | MEDIUM | MEDIUM                         | Claude Code, Codex |
| 5   | Compaction Context Is Hook-Gated                                   | LOW    | LOW                            | Codex              |
| 6   | Codex Cloud Sandbox Deployment                                     | LOW    | LOW                            | Codex Cloud        |
| 7   | Slash Commands Are Not a Distinct, Plugin-Shareable Surface        | LOW    | LOW                            | Claude Code, Codex |

## Enforcement Levels

FlowGuard operates at different enforcement levels depending on the host platform:

| Level         | Platform            | Guarantee                                                                                       |
| ------------- | ------------------- | ----------------------------------------------------------------------------------------------- |
| `synchronous` | OpenCode Plugin SDK | In-process enforcement. Tool call blocked synchronously before execution. Full fail-closed.     |
| `hook_gated`  | Claude Code, Codex  | Out-of-process hook evaluation. Best-effort fail-closed — platform may proceed on hook failure. |
| `advisory`    | Any (MCP-only)      | Governance decisions returned as tool output. LLM must comply voluntarily.                      |

---

## Gap 1: Tool Argument Mutation Is Host-Limited

**Impact**: LOW

**Description**: FlowGuard's OpenCode plugin strips null-valued args from tool inputs (DeepSeek R1 compatibility fix) in-process. Out-of-process platforms expose host-specific mutation surfaces, but these remain hook-mediated rather than equivalent to OpenCode's synchronous plugin path.

**Platform behavior**:

- Claude Code `PreToolUse`: supports `updatedInput` through hook decision output, subject to hook execution semantics.
- Codex `PreToolUse`: supports `updatedInput` for supported tool calls, but unsupported output shapes are reported as hook errors and tool execution may continue.

**Mitigation implemented**:

- Arg sanitization moved to the MCP server layer (`src/mcp-server/tool-adapter.ts`)
- When the LLM calls FlowGuard MCP tools, null args are stripped before processing
- For host tools (Bash, Edit): null args do not cause failures on Claude/Codex models

**Code reference**: `src/mcp-server/tool-adapter.ts:sanitizeNullArgs()`

**Residual Risk**: LOW — The null arg issue is mitigated at the MCP adapter layer for FlowGuard tool calls. Host-tool mutation is still not treated as a FlowGuard SSOT because hook failures remain platform-mediated.

---

## Gap 2: Hook Latency (Process Spawn Overhead)

**Impact**: MEDIUM

**Description**: Each PreToolUse hook invocation in command mode spawns a new Node.js process (~100-200ms overhead). This adds latency to every tool call.

**Platform behavior**:

- Claude Code: Supports `"type": "http"` hooks (persistent server, ~5-20ms latency)
- Codex: Only `"type": "command"` hooks (no HTTP hook support)

**Mitigation implemented**:

1. **Claude Code default (command hooks)**: Process spawn hook (~100-200ms). Generated plugin config uses `"type": "command"` — HTTP hooks are **not** part of the default generated configuration. An HTTP hook server (`src/hooks/http-server.ts`) exists but requires external process management (systemd, Docker, manual start) and manual `"type": "http"` configuration in `hooks.json`.
2. **Codex**: Command hooks optimized for fast startup (minimal imports, single-file entry points, no dynamic require). HTTP hooks not supported by Codex.
3. **Session caching** (HTTP mode): Session state cached in memory when running in HTTP server mode (Claude Code only).

**Code references**:

- `src/hooks/http-server.ts` (425 LOC, persistent server)
- `src/hooks/pre-tool-use.ts` (158 LOC, fast-path command hook)

**Residual Risk**:

- Claude Code default (command hooks): MEDIUM (~100-200ms per call). LOW available only with optional externally managed HTTP hook server.
- Codex: MEDIUM (~150-200ms per call, command hooks only — HTTP not supported).

---

## Gap 3: Hook Timeout = Tool Proceeds

**Impact**: HIGH

**Description**: Both Claude Code and Codex allow tool execution to proceed if a PreToolUse hook times out or crashes. This violates strict fail-closed semantics.

**Platform behavior**:

- Claude Code: Hook timeout → non-blocking error, execution continues
- Codex: Hook timeout → tool proceeds

**Mitigation implemented**:

1. **Aggressive timeouts**: PreToolUse hooks configured with 10s timeout (vs 600s platform default). Fast failure rather than hanging.
2. **Fast execution**: Hook scripts complete in <50ms (command) or <20ms (optional HTTP mode). Timeout risk minimized.
3. **Audit trail**: PostToolUse persists tool-call audit events to the JSONL audit trail. PreToolUse gate decisions and hook failures/timeouts are not persisted as dedicated JSONL audit events by default; they may only be visible through host or stderr logs or inferred from subsequent tool-call records.
4. **HTTP health monitoring** (optional HTTP mode only): Claude Code HTTP hooks include `/health` endpoint for liveness verification.
5. **Fail-closed on internal error**: Hook scripts catch all exceptions and emit deny — crashes produce explicit denials, not silent pass-through.

**Code references**:

- `src/templates/claude-code-plugin.ts` (timeout: 10s)
- `src/templates/codex-plugin.ts` (timeout: 10s)
- `src/hooks/http-server.ts:388-402` (fail-closed on handler error)

**Residual Risk**: HIGH — This is a fundamental platform limitation. If the hook process is killed by the OS (OOM, SIGKILL) or the HTTP server crashes without restart, the platform will allow tool execution without governance. This is documented as "best-effort fail-closed" for out-of-process platforms.

**Recommendation for critical deployments**: Use Claude Code with HTTP hooks and external process monitoring (systemd, Docker health checks) to restart the hook server on failure.

---

## Gap 4: Subagent Orchestration Has No OpenCode-Equivalent Plugin Handshake

**Impact**: MEDIUM

**Description**: Claude Code and Codex both support subagents and subagent lifecycle hooks, but they do not provide FlowGuard's OpenCode in-process plugin handshake (`pluginHandshakeAt`) for review-loop Mode B acceptance. The review flow depends on the host/agent following instructions to invoke the reviewer and on FlowGuard validating the resulting review evidence through the canonical review-evidence gate.

**Platform behavior**:

- OpenCode: FlowGuard plugin hooks set `pluginHandshakeAt` and record host-orchestrated invocation evidence in-process.
- Claude Code: Native subagents exist, and hooks expose `SubagentStart`/`SubagentStop`, but these are transport/isolation signals only and do not set OpenCode plugin handshake evidence.
- Codex: Native subagents/custom agents exist, and hooks expose `SubagentStart`/`SubagentStop`, but command-hook evidence is not an OpenCode-equivalent in-process plugin handshake.

**Mitigation implemented**:

1. **Explicit instructions**: FlowGuard tools return unambiguous instructions for invoking the native reviewer transport.
2. **Evidence binding**: Claude/Codex review completion requires validated, obligation-bound `manual_attested` / transport ReviewInvocationEvidence. File presence, copied JSON, and `flowguard_decision` are not review evidence.
3. **Gate enforcement**: PreToolUse hook blocks mutating tools until review evidence exists on disk where the host can enforce hooks.
4. **Escalating warnings**: PostToolUse hook surfaces time-based escalating warnings when review obligations remain pending (info → warn → critical).
5. **Defense-in-depth**: `isSubagentAuthorized()` blocks unauthorized subagent types.

**Code references**:

- `src/hooks/shared/obligation-tracker.ts` (escalation logic)
- `src/hooks/post-tool-use.ts:104-107` (escalation integration)
- `src/hooks/shared/phase-gate.ts:isSubagentAuthorized()` (defense-in-depth)

**Residual Risk**: MEDIUM — LLM may ignore reviewer instructions, or hook-gated hosts may fail open on hook failure. FlowGuard does not silently accept this: `host_task_required` still requires OpenCode host-visible plugin evidence, and Claude/Codex Mode B convergence is accepted only through validated `manual_attested` evidence bound to the active obligation, findings hash, session id, mandate digest, criteria version, and strict attestation.

---

## Gap 5: Compaction Context Is Hook-Gated

**Impact**: LOW

**Description**: Codex supports `PreCompact` and `PostCompact` hooks, but compaction context remains hook-gated and therefore does not provide OpenCode-style in-process enforcement. If hook execution is skipped, disabled, or fails open, the model may lose awareness of current phase/constraints.

**Platform behavior**:

- Claude Code: Has `PreCompact`/`PostCompact` hooks — can inject context.
- Codex: Has `PreCompact`/`PostCompact` hooks — can inject context when hooks are enabled and trusted.

**Mitigation implemented**:

1. **Self-documenting tool output**: All 12 FlowGuard MCP tools return `phase` in their response. Governance state is embedded in every tool interaction.
2. **AGENTS.md instructions**: Document `flowguard_status` as the re-orientation command after compaction.
3. **Status tool**: `flowguard_status` returns comprehensive governance state (phase, policy mode, obligations, completeness matrix).

**Code references**:

- All tool implementations in `src/integration/tools/` include `phase` in output
- `src/integration/tools/status-tool.ts` (full governance projection)

**Residual Risk**: LOW — Self-documenting output ensures governance context is available in every FlowGuard tool response. Post-compaction re-orientation may require one extra `flowguard_status` call if hook-gated context injection did not run.

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

## Gap 7: Slash Commands Are Not a Distinct, Plugin-Shareable Surface

**Impact**: LOW

**Description**: FlowGuard exposes governed actions as `/<name>` slash commands on
OpenCode through the plugin SDK (`.opencode/command/*.md`). Out-of-process hosts do
not provide an equivalent _distinct_ command surface:

- **Claude Code**: plugin commands and skills load into a **single flat
  namespace**. A plugin `commands/foo.md` and a `skills/foo/SKILL.md` both surface
  as `/foo` (and collide if both define the same name); there is **no**
  `/flowguard:<name>` command namespace and no separate "Commands" category.
  Verified against `claude` 2.1.159 via the auth-free `plugin details` inventory,
  which reports a single "Skills" category only.
- **Codex**: custom prompts are deprecated, resolved only from the user home
  directory (`~/.codex/prompts`), and cannot be distributed inside a plugin. (Per
  Codex documentation; `NOT_VERIFIED` at runtime — no Codex CLI was available to
  confirm.)

**Behavior**: FlowGuard ships a small set of thin, MCP-routing **skills** on
Claude Code and Codex rather than bundling the OpenCode command bodies (which are
authored for OpenCode's `agent: build` pipeline and carry a high always-on token
cost). Governance authority is unchanged — it remains in the MCP tools, hooks,
state, policy, and validated review evidence.

**Code reference**: `src/templates/claude-code-plugin.ts` (skills + MCP, no
bundled `commands/`), `src/templates/codex-plugin.ts` (no `commands/` entries).

**Residual Risk**: LOW — only the slash-command ergonomics differ across hosts.
The governed workflow remains reachable through FlowGuard skills and MCP tools; no
governed capability is lost.

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
