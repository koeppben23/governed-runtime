#!/usr/bin/env node
/**
 * @module hooks/pre-tool-use
 * @description FlowGuard PreToolUse command hook — phase-aware tool gate.
 *
 * This script is invoked by Claude Code or Codex before each tool execution.
 * It reads the hook payload from stdin, evaluates the phase gate, and either:
 * - Exits 0 with no output (ALLOW)
 * - Writes deny JSON to stdout and exits 0 (DENY)
 *
 * Fail-closed behavior:
 * - State unreadable → DENY (explicit error, never silent pass)
 * - Malformed stdin → DENY (explicit error, never silent pass)
 * - Any internal error → DENY (defensive)
 *
 * Decision logic delegates to the same `isHostToolAllowedInPhase()` function
 * used by the OpenCode plugin — no duplicate authority.
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 * @version v1
 */

import { readStdin, validateToolHookPayload } from './shared/stdin-reader.js';
import { DenyOutputError, writeDeny, writeLog } from './shared/stdout-writer.js';
import { resolveSession } from './shared/session-resolver.js';
import { detectPlatform } from './shared/platform-detect.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isSubagentAuthorized,
} from './shared/phase-gate.js';

// ─── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  let payload: Record<string, unknown>;
  try {
    payload = await readStdin();
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeLog(`DENY (fail-closed stdin): ${reason}`);
    await writeDeny('PreToolUse', 'HOOK_STDIN_INVALID', reason);
    return;
  }

  const platform = detectPlatform(payload);
  writeLog(`platform: ${platform}`);

  let validated: ReturnType<typeof validateToolHookPayload>;
  try {
    validated = validateToolHookPayload(payload);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    writeLog(`DENY (fail-closed validation): ${reason}`);
    await writeDeny('PreToolUse', 'HOOK_PAYLOAD_INVALID', reason);
    return;
  }

  const { tool_name, session_id, cwd } = validated;

  // Normalize tool name to lowercase for comparison.
  // Claude Code/Codex may send "Bash", "Write", "Edit" (capitalized).
  const toolNameLower = tool_name.toLowerCase();

  // Fast path: non-mutating tools always allowed — skip state read entirely.
  // Exception: `task` tool may require subagent authorization check.
  if (!isMutatingHostTool(toolNameLower) && toolNameLower !== 'task') {
    writeLog(`ALLOW: ${tool_name} (non-mutating)`);
    return;
  }

  // Defense-in-depth: subagent authorization check.
  // If `task` tool with `subagent_type` — only authorized reviewer type allowed.
  const subagentGate = isSubagentAuthorized(toolNameLower, validated.tool_input);
  if (!subagentGate.allowed) {
    writeLog(`DENY (subagent): ${tool_name} — ${subagentGate.code}: ${subagentGate.reason}`);
    await writeDeny('PreToolUse', subagentGate.code!, subagentGate.reason!);
    return;
  }

  // After subagent check: if non-mutating (task without subagent_type, etc.), allow.
  if (!isMutatingHostTool(toolNameLower)) {
    writeLog(`ALLOW: ${tool_name} (non-mutating)`);
    return;
  }

  // Mutating tool — need to read state for phase gate check.
  const resolution = await resolveSession(cwd, session_id);

  if (!resolution.ok) {
    // Fail-closed: cannot read state → deny.
    writeLog(`DENY (fail-closed): ${resolution.code} — ${resolution.reason}`);
    await writeDeny('PreToolUse', resolution.code, resolution.reason);
    return;
  }

  const { state } = resolution;
  const gateResult = isHostToolAllowedInPhase(toolNameLower, state.phase);

  if (!gateResult.allowed) {
    writeLog(`DENY: ${tool_name} blocked in phase ${state.phase} (${gateResult.code})`);
    await writeDeny('PreToolUse', gateResult.code!, gateResult.reason!);
    return;
  }

  writeLog(`ALLOW: ${tool_name} in phase ${state.phase}`);
  // Exit 0 with no stdout = ALLOW
}

main().catch((err: unknown) => {
  if (err instanceof DenyOutputError) return;
  const reason = err instanceof Error ? err.message : String(err);
  writeLog(`DENY (fatal): ${reason}`);
  void writeDeny('PreToolUse', 'HOOK_FATAL_ERROR', reason).catch(() => undefined);
});
