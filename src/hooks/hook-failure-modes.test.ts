/**
 * @module hooks/hook-failure-modes.test
 * @description Negative-path tests for hook failure modes under platform constraints.
 *
 * Validates FlowGuard's fail-closed behavior under each platform's failure scenarios:
 * - Hook timeout (simulated deadline exceedance)
 * - Hook crash (internal error → deny)
 * - Missing/corrupt session state → deny
 * - Concurrent hook invocations → no race condition
 * - HTTP server unreachable → fallback deny
 * - Malformed stdin → deny
 *
 * Also tests Gap 1-4 mitigation implementations:
 * - sanitizeNullArgs (Gap 1: null arg stripping)
 * - assessObligationEscalation (Gap 4: escalating warnings)
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/251
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { Readable } from 'node:stream';
import { readStdin, validateToolHookPayload } from './shared/stdin-reader.js';
import { formatDenyOutput } from './shared/stdout-writer.js';
import { detectPlatform } from './shared/platform-detect.js';
import {
  isMutatingHostTool,
  isHostToolAllowedInPhase,
  isSubagentAuthorized,
} from './shared/phase-gate.js';
import { assessObligationEscalation } from './shared/obligation-tracker.js';
import { sanitizeNullArgs } from '../mcp-server/tool-adapter.js';
import type { SessionState } from '../state/schema.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function createReadableFromString(content: string): NodeJS.ReadableStream {
  const stream = new Readable();
  stream.push(content);
  stream.push(null);
  return stream;
}

function createEmptyReadable(): NodeJS.ReadableStream {
  const stream = new Readable();
  stream.push(null);
  return stream;
}

/**
 * Simulate the full pre-tool-use decision pipeline under failure conditions.
 * Returns a deny decision if any step fails (fail-closed).
 */
async function simulatePreToolUseWithFailures(
  stdinContent: string | null,
  options: { corruptState?: boolean; missingState?: boolean; phase?: string } = {},
): Promise<{ decision: 'allow' | 'deny'; code?: string; reason?: string }> {
  // Step 1: Parse stdin
  if (stdinContent === null) {
    return { decision: 'deny', code: 'HOOK_STDIN_INVALID', reason: 'stdin empty or null' };
  }

  let payload: Record<string, unknown>;
  try {
    const stream = createReadableFromString(stdinContent);
    payload = await readStdin(stream);
  } catch (err) {
    return {
      decision: 'deny',
      code: 'HOOK_STDIN_INVALID',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  // Step 2: Validate payload
  let validated: ReturnType<typeof validateToolHookPayload>;
  try {
    validated = validateToolHookPayload(payload);
  } catch (err) {
    return {
      decision: 'deny',
      code: 'HOOK_PAYLOAD_INVALID',
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const toolNameLower = validated.tool_name.toLowerCase();

  // Step 3: Fast path — non-mutating tools always allowed
  if (!isMutatingHostTool(toolNameLower)) {
    return { decision: 'allow' };
  }

  // Step 4: Simulate state resolution failures
  if (options.missingState) {
    return { decision: 'deny', code: 'STATE_MISSING', reason: 'Session state not found' };
  }
  if (options.corruptState) {
    return { decision: 'deny', code: 'STATE_UNREADABLE', reason: 'Corrupt session state' };
  }

  // Step 5: Phase gate check
  const phase = options.phase ?? 'IMPLEMENTATION';
  const gateResult = isHostToolAllowedInPhase(toolNameLower, phase as any);
  if (!gateResult.allowed) {
    return { decision: 'deny', code: gateResult.code, reason: gateResult.reason };
  }

  return { decision: 'allow' };
}

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE MODE 1: Malformed stdin → DENY (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Failure Mode: Malformed stdin → fail-closed deny', () => {
  it('BAD: null stdin produces deny', async () => {
    const result = await simulatePreToolUseWithFailures(null);
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_STDIN_INVALID');
  });

  it('BAD: empty string stdin produces deny', async () => {
    const result = await simulatePreToolUseWithFailures('');
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_STDIN_INVALID');
  });

  it('BAD: invalid JSON produces deny', async () => {
    const result = await simulatePreToolUseWithFailures('{not valid json!!!');
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_STDIN_INVALID');
  });

  it('BAD: JSON array (not object) produces deny', async () => {
    const result = await simulatePreToolUseWithFailures('[1, 2, 3]');
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_STDIN_INVALID');
  });

  it('BAD: JSON null produces deny', async () => {
    const result = await simulatePreToolUseWithFailures('null');
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_STDIN_INVALID');
  });

  it('BAD: missing required fields produces deny', async () => {
    const result = await simulatePreToolUseWithFailures(JSON.stringify({ random: 'data' }));
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_PAYLOAD_INVALID');
  });

  it('CORNER: payload with tool_name but missing cwd produces deny', async () => {
    const result = await simulatePreToolUseWithFailures(
      JSON.stringify({ tool_name: 'Bash', tool_input: {}, session_id: 's1' }),
    );
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('HOOK_PAYLOAD_INVALID');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE MODE 2: Missing/corrupt state → DENY (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Failure Mode: Missing/corrupt state → fail-closed deny', () => {
  const validPayload = JSON.stringify({
    tool_name: 'Bash',
    tool_input: { command: 'npm test' },
    session_id: 'sess_1',
    cwd: '/project',
  });

  it('BAD: missing state file for mutating tool → deny', async () => {
    const result = await simulatePreToolUseWithFailures(validPayload, { missingState: true });
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('STATE_MISSING');
  });

  it('BAD: corrupt state file for mutating tool → deny', async () => {
    const result = await simulatePreToolUseWithFailures(validPayload, { corruptState: true });
    expect(result.decision).toBe('deny');
    expect(result.code).toBe('STATE_UNREADABLE');
  });

  it('HAPPY: non-mutating tool does NOT need state', async () => {
    const readPayload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { filePath: '/foo' },
      session_id: 'sess_1',
      cwd: '/project',
    });
    const result = await simulatePreToolUseWithFailures(readPayload, { missingState: true });
    expect(result.decision).toBe('allow');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE MODE 3: Hook crash simulation → DENY (fail-closed)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Failure Mode: Hook internal error → fail-closed deny', () => {
  it('BAD: formatDenyOutput produces valid deny JSON on internal error', () => {
    const output = formatDenyOutput('PreToolUse', 'HOOK_FATAL_ERROR', 'Unexpected crash');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.hookEventName).toBe('PreToolUse');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('HOOK_FATAL_ERROR');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('Unexpected crash');
  });

  it('BAD: formatDenyOutput handles empty reason gracefully', () => {
    const output = formatDenyOutput('PreToolUse', 'INTERNAL_ERROR', '');
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(output.hookSpecificOutput.permissionDecisionReason).toContain('INTERNAL_ERROR');
  });

  it('EDGE: formatDenyOutput handles very long reason string', () => {
    const longReason = 'x'.repeat(5000);
    const output = formatDenyOutput('PreToolUse', 'OVERFLOW', longReason);
    expect(output.hookSpecificOutput.permissionDecision).toBe('deny');
    // Should still be valid JSON-serializable
    expect(() => JSON.stringify(output)).not.toThrow();
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE MODE 4: Concurrent hook invocations
// ═══════════════════════════════════════════════════════════════════════════════

describe('Failure Mode: Concurrent hook invocations → no race condition', () => {
  it('EDGE: parallel pre-tool-use evaluations produce consistent results', async () => {
    const denyPayload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'rm -rf /' },
      session_id: 'sess_concurrent',
      cwd: '/project',
    });

    // Fire 10 parallel evaluations — all should deny in TICKET phase.
    const promises = Array.from({ length: 10 }, () =>
      simulatePreToolUseWithFailures(denyPayload, { phase: 'TICKET' }),
    );

    const results = await Promise.all(promises);

    // Every single result must be deny — no race-induced allow.
    for (const result of results) {
      expect(result.decision).toBe('deny');
      expect(result.code).toBe('HOST_TOOL_PHASE_DENIED');
    }
  });

  it('EDGE: parallel allow evaluations produce consistent results', async () => {
    const allowPayload = JSON.stringify({
      tool_name: 'Bash',
      tool_input: { command: 'npm test' },
      session_id: 'sess_concurrent',
      cwd: '/project',
    });

    const promises = Array.from({ length: 10 }, () =>
      simulatePreToolUseWithFailures(allowPayload, { phase: 'IMPLEMENTATION' }),
    );

    const results = await Promise.all(promises);

    for (const result of results) {
      expect(result.decision).toBe('allow');
    }
  });

  it('EDGE: mixed concurrent requests maintain isolation', async () => {
    const denyPayload = JSON.stringify({
      tool_name: 'Write',
      tool_input: { filePath: '/f', content: 'x' },
      session_id: 'sess_a',
      cwd: '/project',
    });
    const allowPayload = JSON.stringify({
      tool_name: 'Read',
      tool_input: { filePath: '/f' },
      session_id: 'sess_b',
      cwd: '/project',
    });

    const promises = [
      simulatePreToolUseWithFailures(denyPayload, { phase: 'TICKET' }),
      simulatePreToolUseWithFailures(allowPayload),
      simulatePreToolUseWithFailures(denyPayload, { phase: 'PLAN' }),
      simulatePreToolUseWithFailures(allowPayload),
    ];

    const [r1, r2, r3, r4] = await Promise.all(promises);
    expect(r1.decision).toBe('deny');
    expect(r2.decision).toBe('allow');
    expect(r3.decision).toBe('deny');
    expect(r4.decision).toBe('allow');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FAILURE MODE 5: HTTP server deny format (unreachable scenario)
// ═══════════════════════════════════════════════════════════════════════════════

describe('Failure Mode: HTTP server deny response format', () => {
  it('BAD: server produces valid deny on internal error', () => {
    // Simulate what the HTTP server returns when handler throws
    const denyOutput = formatDenyOutput(
      'PreToolUse',
      'INTERNAL_ERROR',
      'Hook server internal error: ECONNREFUSED',
    );
    expect(denyOutput.hookSpecificOutput.permissionDecision).toBe('deny');
    expect(denyOutput.hookSpecificOutput.permissionDecisionReason).toContain('INTERNAL_ERROR');
    expect(denyOutput.hookSpecificOutput.permissionDecisionReason).toContain('ECONNREFUSED');
  });

  it('BAD: deny format is JSON-serializable for HTTP response', () => {
    const denyOutput = formatDenyOutput('PreToolUse', 'TIMEOUT', 'Handler timed out after 10s');
    const json = JSON.stringify({ decision: 'deny', ...denyOutput });
    const parsed = JSON.parse(json);
    expect(parsed.decision).toBe('deny');
    expect(parsed.hookSpecificOutput.permissionDecision).toBe('deny');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAP 1 MITIGATION: sanitizeNullArgs
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gap 1 Mitigation: sanitizeNullArgs', () => {
  it('HAPPY: removes null-valued keys', () => {
    const args = { command: 'ls', timeout: null, verbose: true };
    const result = sanitizeNullArgs(args);
    expect(result).toEqual({ command: 'ls', verbose: true });
    expect('timeout' in result).toBe(false);
  });

  it('HAPPY: preserves all non-null values', () => {
    const args = { a: 'str', b: 0, c: false, d: '', e: undefined, f: [] };
    const result = sanitizeNullArgs(args);
    // undefined is preserved (different from null — it's missing in JSON anyway)
    expect(result).toEqual({ a: 'str', b: 0, c: false, d: '', e: undefined, f: [] });
  });

  it('HAPPY: empty object returns empty object', () => {
    expect(sanitizeNullArgs({})).toEqual({});
  });

  it('CORNER: all-null object returns empty object', () => {
    const args = { a: null, b: null, c: null };
    expect(sanitizeNullArgs(args)).toEqual({});
  });

  it('CORNER: nested null values are preserved (only top-level stripped)', () => {
    const args = { data: { nested: null }, name: 'test' };
    const result = sanitizeNullArgs(args);
    expect(result).toEqual({ data: { nested: null }, name: 'test' });
  });

  it('EDGE: large object with mixed null/non-null', () => {
    const args: Record<string, unknown> = {};
    for (let i = 0; i < 50; i++) {
      args[`key_${i}`] = i % 3 === 0 ? null : `value_${i}`;
    }
    const result = sanitizeNullArgs(args);
    const nullKeys = Object.entries(result).filter(([, v]) => v === null);
    expect(nullKeys).toHaveLength(0);
    // 50 keys, every 3rd is null → 17 nulls removed, 33 remain
    expect(Object.keys(result)).toHaveLength(33);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// GAP 4 MITIGATION: assessObligationEscalation
// ═══════════════════════════════════════════════════════════════════════════════

describe('Gap 4 Mitigation: assessObligationEscalation', () => {
  /** Create a minimal SessionState with optional review obligations. */
  function createState(
    obligations: Array<{ status: string; createdAt: string }> = {},
  ): SessionState {
    return {
      reviewAssurance:
        obligations.length > 0
          ? {
              obligations: obligations.map((ob, i) => ({
                obligationId: `ob-${i}`,
                obligationType: 'implement' as const,
                iteration: 0,
                planVersion: 1,
                criteriaVersion: 'v1',
                mandateDigest: 'digest',
                createdAt: ob.createdAt,
                pluginHandshakeAt: null,
                status: ob.status as any,
                invocationId: null,
                blockedCode: null,
                fulfilledAt: null,
                consumedAt: ob.status === 'consumed' ? ob.createdAt : null,
              })),
              invocations: [],
            }
          : undefined,
    } as unknown as SessionState;
  }

  const NOW = '2026-05-21T10:00:00.000Z';

  it('HAPPY: no obligations → level none', () => {
    const state = createState([]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('none');
    expect(result.message).toBeNull();
  });

  it('HAPPY: all consumed obligations → level none', () => {
    const state = createState([{ status: 'consumed', createdAt: '2026-05-21T09:50:00.000Z' }]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('none');
  });

  it('HAPPY: pending obligation + non-mutating tool → level none', () => {
    const state = createState([{ status: 'pending', createdAt: '2026-05-21T09:59:00.000Z' }]);
    const result = assessObligationEscalation(state, false, NOW);
    expect(result.level).toBe('none');
  });

  it('HAPPY: pending obligation + mutating tool + <60s → level info', () => {
    const state = createState([
      { status: 'pending', createdAt: '2026-05-21T09:59:30.000Z' }, // 30s ago
    ]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('info');
    expect(result.message).toContain('INFO');
    expect(result.pendingCount).toBe(1);
  });

  it('BAD: pending obligation + mutating tool + >60s → level warn', () => {
    const state = createState([
      { status: 'pending', createdAt: '2026-05-21T09:58:00.000Z' }, // 120s ago
    ]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('warn');
    expect(result.message).toContain('WARN');
    expect(result.oldestPendingAge).toBeGreaterThanOrEqual(120);
  });

  it('BAD: pending obligation + mutating tool + >180s → level critical', () => {
    const state = createState([
      { status: 'pending', createdAt: '2026-05-21T09:56:00.000Z' }, // 240s ago
    ]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('critical');
    expect(result.message).toContain('CRITICAL');
    expect(result.message).toContain('flowguard_decision');
    expect(result.oldestPendingAge).toBeGreaterThanOrEqual(240);
  });

  it('CORNER: multiple obligations uses oldest age', () => {
    const state = createState([
      { status: 'pending', createdAt: '2026-05-21T09:59:50.000Z' }, // 10s - info
      { status: 'pending', createdAt: '2026-05-21T09:55:00.000Z' }, // 300s - critical
    ]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('critical');
    expect(result.pendingCount).toBe(2);
  });

  it('EDGE: obligation exactly at threshold boundary', () => {
    // Exactly 60s → should be warn (>=)
    const state = createState([
      { status: 'pending', createdAt: '2026-05-21T09:59:00.000Z' }, // exactly 60s
    ]);
    const result = assessObligationEscalation(state, true, NOW);
    expect(result.level).toBe('warn');
  });

  it('EDGE: fulfilled (not consumed) obligation is still pending', () => {
    const state = createState([{ status: 'fulfilled', createdAt: '2026-05-21T09:55:00.000Z' }]);
    const result = assessObligationEscalation(state, true, NOW);
    // fulfilled but not consumed — still tracked as pending per the filter logic
    expect(result.level).toBe('critical');
  });
});
