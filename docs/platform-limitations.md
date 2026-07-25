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

## Gap 8: Parallel Reviewer Host Capability (verified v1.4.0; version transfer pending)

**Impact**: MEDIUM (gates the expanded/parallel review coverage in #730 Wave 2, #736)

**Description**: FlowGuard's roadmap for expanded review coverage (#730 Wave 2)
depends on the OpenCode host supporting **bounded, parallel, read-only reviewer
child sessions of one parent**, including deterministic completion, unique
session identity under concurrency, and in-flight cancellation via the
documented `session.abort({ path })` SDK method.

**Status update (2026-07-24)**: this capability was **originally `NOT_VERIFIED`**
and has now been **verified against a real OpenCode host (Desktop CLI v1.4.0)**
by a live run of the FlowGuard harness (see the parallel live run result below).
The shipped release still spawns exactly one reviewer session at a time; no
product code performs parallel reviewer fan-out yet. Both host-capability gates
(parallelism and structured output) are now verified against v1.4.0; what
remains `NOT_VERIFIED` is version transfer to the FlowGuard-targeted 1.18.x line
and parallel-load abort (details below).

**Decision (2026-07-24): parallel specialist coverage is NOT being built.** A
design and scaffolding effort for the `full` review profile (a per-role prompt
registry, fail-closed findings aggregation, and HIGH-RISK-to-`full` escalation)
was prototyped and then **removed**, because parallel specialist fan-out over the
SDK reviewer path is only reachable when `reviewInvocationPolicy` permits SDK
spawns — i.e. only the SOLO preset (`host_task_preferred`). In the TEAM,
TEAM_CI, and REGULATED presets the reviewer runs through the host-task path
(`host_task_required`), where `invokeReviewer` blocks the SDK spawn and the
agent spawns a single host-visible reviewer under a strict 1:1 obligation
contract. HIGH-RISK work typically runs under exactly those stricter presets, so
the intended benefit (parallel specialists on HIGH-RISK reviews) is not
achievable via the SDK path, and delivering it through the host-task path would
require breaking the fail-closed 1:1 obligation/evidence binding. The `full`
review profile therefore remains a **reserved, inert enum value** (as before),
with no producer, no marker, and no escalation. The verified host-capability
evidence above is retained as reference; #736 (parallel specialist
orchestration) is **not planned** on the SDK path.

**What has been built and what it proves**:

- A **non-shipped** measurement harness and deterministic fake client live under
  `src/integration/review/__tests__/` (excluded from the production `tsc` build,
  so they never reach `dist/`, the only packaged output).
- The harness enforces a **bounded-concurrency** guarantee in FlowGuard-owned
  code; that bound is genuinely tested and holds independently of any host.
- All other harness tests are **self-consistency checks**: they document how the
  harness interprets the documented SDK session semantics against our own fake.
  They are an executable specification, **not** evidence of real host behavior.

**Verification path (Strang 2 / #732)**: run the same harness against a real
OpenCode instance and analyze the emitted structured evidence (parent/child
session correlation, per-child timing, completion ordering). This live run has
now been performed (see results below); the remaining gates are structured
output and target-version confirmation, not basic host parallelism.

**Feasibility spike result (2026-07-24, OpenCode Desktop CLI v1.4.0)**: a
read-only, throwaway spike verified the underlying single-session host
primitives against a live `opencode serve` instance (headless HTTP, Basic auth
via `OPENCODE_SERVER_PASSWORD`):

- `POST /session` creates a session; passing `parentID` creates a **child whose
  `parentID` is set correctly** — real parent→child correlation over the host.
- `POST /session/{id}/message` runs a prompt to **deterministic completion**
  (`finish: "stop"`, ~3 s on a free model) with per-message timing and token
  accounting — the per-child timing signal Gap 8 requires.
- `POST /session/{id}/abort` returns `200 true` — in-flight cancellation exists.

This raises the create / prompt-completion / abort primitives from
`NOT_VERIFIED` to **verified for a single session (v1.4.0)**.

**Parallel live run result (2026-07-24, OpenCode Desktop CLI v1.4.0)**: the
FlowGuard `runParallelProbe` harness (the exact unit-tested harness, driven
through a raw-`fetch` REST adapter over the documented HTTP API — no
`@opencode-ai/sdk` import) was run against a live `opencode serve` instance with
`maxConcurrency = 3` and 4 read-only child prompts under one parent. The
harness is a gated live test (`src/integration/review/__tests__/parallel-host-probe-live.test.ts`,
skipped unless `OPENCODE_LIVE=1` and `OPENCODE_CLI` are set, so CI never depends
on a host). Observed:

- **`peakObservedConcurrency = 3`** — the host genuinely ran three child
  sessions of one parent simultaneously; it does **not** serialize prompts.
- **4 unique child session ids** under one parent (unique identity under
  concurrency).
- **All 4 completed deterministically**; complete completion-ordering sequence
  1..4. Per-child durations diverged widely (5.0 / 22.9 / 24.8 / 34.8 s) and the
  completion order differed from dispatch order (the 5.0 s child finished first,
  sequence 1; a 34.8 s child finished last, sequence 4) — direct evidence of
  concurrent, not serialized, execution.

This raises **bounded, parallel, read-only reviewer child sessions with unique
identity, deterministic completion, and observable completion ordering** from
`NOT_VERIFIED` to **verified against a real host (v1.4.0)**.

**Structured-output live run result (2026-07-24, OpenCode Desktop CLI v1.4.0)**:
a gated live test issued a `POST /session/{id}/message` with
`format: { type: 'json_schema', schema, retryCount: 1 }` (a minimal reviewer
verdict schema) and observed:

- The host **accepts** the `format: json_schema` field (HTTP 200, no 400) and
  returns **schema-validated** data: the assistant message carries a `tool`
  part `tool: "StructuredOutput"` whose `state.status = "completed"`,
  `state.metadata.valid = true`, and `state.input = { verdict: "accept" }` — the
  schema-conformant object.
- **Integration note (mechanism differs from the FlowGuard client contract)**:
  the structured result is delivered in the `StructuredOutput` tool part's
  `state.input`, and `finish` is `"tool-calls"` (not `"stop"`). There is **no
  `info.structured_output` field** on this host version, whereas
  `OrchestratorClient` (src/integration/review/types.ts) reads
  `info.structured_output`/`info.structured`. Wave 2 orchestration must extract
  from the tool part on this host line.
- A **tool-calling-capable model is required**: the free tier
  (`deepseek-v4-flash-free`) returned 0 tokens and no tool call; a capable model
  (`claude-sonnet-4.6`) produced the validated output. This is a model, not a
  host, limitation.

This raises **structured-output delivery** from `NOT_VERIFIED` to **verified
against a real host (v1.4.0)**.

**What remains `NOT_VERIFIED`**: in-flight cancellation under _parallel_ load
(single-session abort returns `200 true`, but a parallel abort race was not
exercised), and **version transfer** to the FlowGuard-targeted SDK line (plugin
pin 1.18.x vs. the 1.4.0 CLI probed here). #736 (parallel specialist
orchestration) is therefore no longer blocked on host parallelism or structured
output; it remains gated only on target-version confirmation and the client-side
adaptation to read structured results from the `StructuredOutput` tool part.

---

## Risk Acceptance Matrix

| Residual Risk | Acceptance Criteria                         | Monitoring                                                         |
| ------------- | ------------------------------------------- | ------------------------------------------------------------------ |
| LOW           | Acceptable for all deployments              | Standard audit trail review                                        |
| MEDIUM        | Acceptable with documented awareness        | Audit trail + obligation escalation warnings                       |
| HIGH (Gap 3)  | Requires explicit organizational acceptance | External process monitoring, health checks, incident response plan |

## OpenCode instruction-source: configured is not activated

FlowGuard installs its mandates by registering an entry in the OpenCode
`instructions[]` array. Per the official OpenCode documentation this is the
documented mechanism for loading instruction sources, exposed to both the CLI
and the Desktop app:

- <https://opencode.ai/docs/config#instructions> (retrieved 2026-07)
- <https://opencode.ai/docs/rules> (retrieved 2026-07)

**A present `instructions[]` entry means the instruction source is _configured_.
It does not prove the runtime loaded the mandates into the model context.**
FlowGuard has no reliable surface to verify activation: the Desktop app exposes
no `opencode --version` executable and OpenCode offers no documented API that
reports the resolved instruction sources or the composed system prompt.
FlowGuard therefore never claims the mandates are "active", "supported", or that
a runtime is "compatible".

What the tools report honestly:

- `flowguard doctor` — the instruction-source check is `ok` only in the sense
  that the entry is **configured**. Its detail states explicitly that
  activation is not verifiable by FlowGuard. It does not turn the installation
  green under a false "supported" claim.
- `flowguard install` — writes the config and mandate file, then emits a notice
  that mandates are **configured** and that activation is not verified by
  install. It does not claim the runtime is governed.
- An unknown or Desktop runtime is **never** classified as compatible. It is
  simply `configured` (present, activation unverified).

Fail-closed exception (deny-list): if a runtime is _positively known_ — with
cited evidence — to accept the `instructions[]` entry without resolving it, it
yields the `OPENCODE_INSTRUCTION_SOURCE_UNSUPPORTED` reason in `flowguard
doctor` and a non-clean `flowguard install` result (artifacts are written but
mandates are reported as NOT active — "write but refuse"). The deny-list
(`KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES` in
`src/cli/opencode-runtime-compat.ts`) is seeded empty; no such runtime is
currently known.

`flowguard doctor` and `flowguard install` record the detected OpenCode version
(best-effort, CLI only), runtime kind, executable path, OS, install method, and
install date to the FlowGuard logs. The Desktop app exposes no
`opencode --version` executable, so its version is logged as `null`; this is a
detection limitation and does not by itself imply activation either way.

`NOT_VERIFIED`: FlowGuard does not prove instruction-source activation on any
runtime. A future mechanism could verify activation if OpenCode exposes the
resolved instruction sources or the composed agent system prompt.

## References

- `src/adapters/host-adapter.ts` — Host-Agnostic Adapter Interface (HAI)
- `src/hooks/http-server.ts` — HTTP hook server for Claude Code
- `src/hooks/shared/obligation-tracker.ts` — Review obligation escalation
- `src/mcp-server/tool-adapter.ts` — MCP layer arg sanitization
- `scripts/codex-cloud-setup.sh` — Codex cloud installation
