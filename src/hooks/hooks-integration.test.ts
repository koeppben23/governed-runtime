/**
 * @module hooks/hooks-integration.test
 * @description Integration and performance tests for FlowGuard hook scripts.
 *
 * Tests the full hook invocation pipeline: stdin → parse → evaluate → stdout.
 * Includes performance budget verification (< 200ms for command hooks).
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/244
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readStdin, validateToolHookPayload } from './shared/stdin-reader.js';
import { detectPlatform } from './shared/platform-detect.js';
import { formatDenyOutput } from './shared/stdout-writer.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isSubagentAuthorized,
} from './shared/phase-gate.js';
import { benchmarkAsync } from '../test-policy.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createReadableFromString(content: string): NodeJS.ReadableStream {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return stream;
}

/** Simulate the full pre-tool-use decision pipeline (stdin parse → gate check). */
async function simulatePreToolUseDecision(stdinJson: string): Promise<{
  decision: 'allow' | 'deny';
  code?: string;
  reason?: string;
}> {
  // Step 1: Parse stdin
  const payload = await readStdin(createReadableFromString(stdinJson));
  const validated = validateToolHookPayload(payload);
  const platform = detectPlatform(payload);

  // Step 2: Normalize tool name (as hook does)
  const toolNameLower = validated.tool_name.toLowerCase();

  // Step 2.5: Subagent authorization check (defense-in-depth)
  const subagentGate = isSubagentAuthorized(toolNameLower, validated.tool_input);
  if (!subagentGate.allowed) {
    return { decision: 'deny', code: subagentGate.code, reason: subagentGate.reason };
  }

  // Step 3: Fast path — non-mutating
  if (!isMutatingHostTool(toolNameLower)) {
    return { decision: 'allow' };
  }

  // Step 4: Phase gate check (skip session resolution for unit-level integration)
  // Use PLAN phase to test deny, IMPLEMENTATION to test allow.
  const phase = ((payload as Record<string, unknown>)['_test_phase'] as string) ?? 'PLAN';
  const gateResult = isHostToolAllowedInPhase(toolNameLower, phase as any);

  if (!gateResult.allowed) {
    return { decision: 'deny', code: gateResult.code, reason: gateResult.reason };
  }

  return { decision: 'allow' };
}

// ─── Integration: Claude Code PreToolUse ─────────────────────────────────────

describe('Integration: Claude Code PreToolUse', () => {
  it('should DENY Bash during investigation phase (TICKET)', async () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /tmp/build' },
      session_id: 'sess_abc123',
      cwd: '/path/to/project',
      transcript_path: '/tmp/transcript.json',
      _test_phase: 'TICKET',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
  });

  it('should DENY Write during PLAN phase', async () => {
    const input = JSON.stringify({
      tool_name: 'Write',
      tool_input: { filePath: '/tmp/file.ts', content: 'code' },
      session_id: 'sess_abc123',
      cwd: '/path/to/project',
      transcript_path: '/tmp/t.json',
      _test_phase: 'PLAN',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('deny');
  });

  it('should ALLOW Bash during IMPLEMENTATION phase', async () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'sess_abc123',
      cwd: '/path/to/project',
      transcript_path: '/tmp/t.json',
      _test_phase: 'IMPLEMENTATION',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('allow');
  });

  it('should ALLOW read-only tools in any phase', async () => {
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: { filePath: '/tmp/file.ts' },
      session_id: 'sess_abc123',
      cwd: '/path/to/project',
      transcript_path: '/tmp/t.json',
      _test_phase: 'TICKET',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('allow');
  });
});

// ─── Integration: Codex PreToolUse ───────────────────────────────────────────

describe('Integration: Codex PreToolUse', () => {
  it('should DENY Bash during ARCHITECTURE phase', async () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'node script.js' },
      session_id: 'thread_abc123',
      cwd: '/path/to/project',
      hook_event_name: 'PreToolUse',
      model: 'o3',
      _test_phase: 'ARCHITECTURE',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
  });

  it('should ALLOW Edit during IMPLEMENTATION phase', async () => {
    const input = JSON.stringify({
      tool_name: 'Edit',
      tool_input: { filePath: '/tmp/f.ts', oldString: 'a', newString: 'b' },
      session_id: 'thread_xyz',
      cwd: '/project',
      hook_event_name: 'PreToolUse',
      _test_phase: 'IMPLEMENTATION',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('allow');
  });

  it('should detect platform as codex', async () => {
    const payload = {
      tool_name: 'Bash',
      session_id: 'thread_1',
      cwd: '/project',
      hook_event_name: 'PreToolUse',
      model: 'o3',
    };
    expect(detectPlatform(payload)).toBe('codex');
  });
});

// ─── Integration: Deny output format ─────────────────────────────────────────

describe('Integration: Deny output format compliance', () => {
  it('should produce valid hookSpecificOutput for deny', () => {
    const output = formatDenyOutput(
      'PreToolUse',
      'HOST_TOOL_PHASE_DENIED',
      "'bash' is not allowed in phase PLAN",
    );

    // Verify JSON serializable
    const json = JSON.stringify(output);
    const parsed = JSON.parse(json);

    expect(parsed.hookSpecificOutput).toBeDefined();
    expect(parsed.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecisionReason).toContain('HOST_TOOL_PHASE_DENIED');
  });

  it('should produce valid deny for all hook events', () => {
    const events = ['PreToolUse', 'PostToolUse', 'SessionStart', 'Stop'] as const;
    for (const event of events) {
      const output = formatDenyOutput(event, 'TEST', 'reason');
      expect(output.hookSpecificOutput.hookEventName).toBe(event);
      expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    }
  });
});

// ─── Performance: Hook decision latency ──────────────────────────────────────

describe('PERF: Hook decision latency', () => {
  const CI_FACTOR = process.env.CI ? 3 : 1;
  const HOOK_BUDGET_MS = 50 * CI_FACTOR; // Decision logic only (no filesystem I/O)

  it('should complete stdin parse + gate check in < 50ms', async () => {
    const input = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'sess_perf_test',
      cwd: '/path/to/project',
      transcript_path: '/tmp/t.json',
      _test_phase: 'PLAN',
    });

    const { p95Ms } = await benchmarkAsync(async () => simulatePreToolUseDecision(input), 20, 3);

    expect(p95Ms).toBeLessThan(HOOK_BUDGET_MS);
  });

  it('should complete allow decision (non-mutating) in < 10ms', async () => {
    const input = JSON.stringify({
      tool_name: 'Read',
      tool_input: { filePath: '/tmp/f.ts' },
      session_id: 'sess_perf',
      cwd: '/project',
      _test_phase: 'TICKET',
    });

    const { p95Ms } = await benchmarkAsync(async () => simulatePreToolUseDecision(input), 20, 3);

    expect(p95Ms).toBeLessThan(10 * CI_FACTOR);
  });

  it('should format deny output in < 1ms', async () => {
    const { p95Ms } = await benchmarkAsync(
      async () => {
        formatDenyOutput('PreToolUse', 'CODE', 'reason '.repeat(50));
      },
      50,
      5,
    );

    expect(p95Ms).toBeLessThan(1 * CI_FACTOR);
  });
});

// ─── Negative Path: Fail-closed behavior ─────────────────────────────────────

describe('Negative Path: Fail-closed behavior', () => {
  it('should produce deny for state resolution failure', () => {
    // Simulates the decision that pre-tool-use.ts makes when resolveSession fails.
    // The hook writes deny output — we verify the format is correct.
    const output = formatDenyOutput(
      'PreToolUse',
      'STATE_UNREADABLE',
      'Session state exists but is unreadable: EACCES permission denied',
    );
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('STATE_UNREADABLE');
  });

  it('should produce deny for missing session directory', () => {
    const output = formatDenyOutput(
      'PreToolUse',
      'SESSION_DIR_NOT_FOUND',
      'Session directory does not exist. Run /hydrate to initialize.',
    );
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('should produce deny for fingerprint failure', () => {
    const output = formatDenyOutput(
      'PreToolUse',
      'FINGERPRINT_FAILED',
      'Cannot compute workspace fingerprint from cwd "/nonexistent"',
    );
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });

  it('should produce deny for missing state file', () => {
    const output = formatDenyOutput(
      'PreToolUse',
      'STATE_MISSING',
      'Session directory exists but contains no state file. Run /hydrate to initialize.',
    );
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// ─── Integration: Subagent Authorization (Defense-in-Depth) ──────────────────

describe('Integration: Subagent Authorization', () => {
  it('should DENY unauthorized subagent via full pipeline (Claude Code)', async () => {
    const input = JSON.stringify({
      tool_name: 'Task',
      tool_input: { subagent_type: 'malicious-exfiltrator', prompt: 'steal secrets' },
      session_id: 'sess_sub_1',
      cwd: '/project',
      transcript_path: '/tmp/t.json',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
    expect(result.reason).toContain('malicious-exfiltrator');
  });

  it('should DENY unauthorized subagent via full pipeline (Codex)', async () => {
    const input = JSON.stringify({
      tool_name: 'Task',
      tool_input: { subagent_type: 'code-gen-bot', prompt: 'generate code' },
      session_id: 'thread_sub_1',
      cwd: '/project',
      hook_event_name: 'PreToolUse',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('SUBAGENT_TYPE_UNAUTHORIZED');
  });

  it('should ALLOW authorized flowguard-reviewer subagent', async () => {
    const input = JSON.stringify({
      tool_name: 'Task',
      tool_input: { subagent_type: 'flowguard-reviewer', prompt: 'Review plan changes' },
      session_id: 'sess_sub_2',
      cwd: '/project',
      transcript_path: '/tmp/t.json',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('allow');
  });

  it('should ALLOW task tool without subagent_type (generic task)', async () => {
    const input = JSON.stringify({
      tool_name: 'Task',
      tool_input: { prompt: 'explore the codebase' },
      session_id: 'sess_sub_3',
      cwd: '/project',
      transcript_path: '/tmp/t.json',
    });

    const result = await simulatePreToolUseDecision(input);
    expect(result.decision).toBe('allow');
  });
});
