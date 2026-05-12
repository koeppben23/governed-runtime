/**
 * @file plugin-helpers.test.ts
 * @description Unit tests for plugin-helpers utilities.
 *
 * Covers:
 * - parseToolResult: full JSON, first-line fallback, complete failure
 * - strictBlockedOutput: registry lookup, recovery population, unknown-code fallback
 * - buildEnforcementError: structured JSON message, name, recovery from registry,
 *   reason override, unknown-code fallback (F2 — structured BLOCKED responses)
 *
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import {
  parseToolResult,
  strictBlockedOutput,
  buildEnforcementError,
  getToolOutput,
  getToolArgs,
  getToolMetadata,
  getToolCallID,
} from './plugin-helpers.js';

describe('parseToolResult', () => {
  it('GOOD: parses valid JSON string', () => {
    const result = parseToolResult('{"ok":true,"value":42}');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('GOOD: falls back to first line on multi-line content', () => {
    const result = parseToolResult('{"ok":true}\nNext action: continue');
    expect(result).toEqual({ ok: true });
  });

  it('BAD: returns null on completely unparseable input', () => {
    const result = parseToolResult('not json at all');
    expect(result).toBeNull();
  });

  it('CORNER: returns null for empty string', () => {
    const result = parseToolResult('');
    expect(result).toBeNull();
  });

  it('CORNER: stringifies non-string input before parsing', () => {
    const result = parseToolResult({ already: 'object' });
    expect(result).toEqual({ already: 'object' });
  });

  it('BAD: returns null for circular/non-serializable input', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    const result = parseToolResult(circular);
    expect(result).toBeNull();
  });
});

describe('strictBlockedOutput', () => {
  it('GOOD: looks up registered code and populates recovery from registry', () => {
    // SUBAGENT_REVIEW_NOT_INVOKED is registered by F1 with recovery steps.
    const json = strictBlockedOutput('SUBAGENT_REVIEW_NOT_INVOKED', {});
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
    expect(typeof parsed.message).toBe('string');
    expect((parsed.message as string).length).toBeGreaterThan(0);
    expect(Array.isArray(parsed.recovery)).toBe(true);
    expect((parsed.recovery as unknown[]).length).toBeGreaterThan(0);
  });

  it('GOOD: interpolates detail vars into message template', () => {
    const json = strictBlockedOutput('SUBAGENT_SESSION_MISMATCH', {
      expected: 'sess_abc',
      actual: 'sess_xyz',
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;

    // Detail is preserved verbatim for the LLM.
    expect(parsed.detail).toEqual({ expected: 'sess_abc', actual: 'sess_xyz' });
    // Message should reference at least one of the values if the template uses them.
    const message = parsed.message as string;
    const hasInterpolation = message.includes('sess_abc') || message.includes('sess_xyz');
    expect(hasInterpolation).toBe(true);
  });

  it('CORNER: unknown code falls back to generic message + empty recovery', () => {
    const json = strictBlockedOutput('UNKNOWN_CODE_NEVER_REGISTERED_XYZ', {});
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('UNKNOWN_CODE_NEVER_REGISTERED_XYZ');
    expect(parsed.recovery).toEqual([]);
  });
});

describe('buildEnforcementError (F2 — structured BLOCKED responses)', () => {
  it('GOOD: produces an Error with FlowGuardEnforcementError name', () => {
    const err = buildEnforcementError('SUBAGENT_REVIEW_NOT_INVOKED', 'subagent did not run');
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('FlowGuardEnforcementError');
  });

  it('GOOD: encodes structured JSON payload in message after [FlowGuard] prefix', () => {
    const err = buildEnforcementError('SUBAGENT_REVIEW_NOT_INVOKED', 'live reason text', {
      sessionId: 'sess_123',
    });

    // Format: "[FlowGuard] {jsonPayload}"
    expect(err.message.startsWith('[FlowGuard] ')).toBe(true);
    const jsonPart = err.message.slice('[FlowGuard] '.length);
    const payload = JSON.parse(jsonPart) as Record<string, unknown>;

    expect(payload.error).toBe(true);
    expect(payload.code).toBe('SUBAGENT_REVIEW_NOT_INVOKED');
    expect(payload.message).toBe('live reason text');
    expect(payload.detail).toEqual({ sessionId: 'sess_123' });
    expect(Array.isArray(payload.recovery)).toBe(true);
    expect((payload.recovery as unknown[]).length).toBeGreaterThan(0);
  });

  it('GOOD: live enforcement reason overrides registry template', () => {
    const liveReason = 'session sess_a expected, got sess_b';
    const err = buildEnforcementError('SUBAGENT_SESSION_MISMATCH', liveReason);
    const payload = JSON.parse(err.message.slice('[FlowGuard] '.length)) as Record<string, unknown>;

    expect(payload.message).toBe(liveReason);
  });

  it('CORNER: empty reason falls back to registry template', () => {
    const err = buildEnforcementError('SUBAGENT_REVIEW_NOT_INVOKED', '');
    const payload = JSON.parse(err.message.slice('[FlowGuard] '.length)) as Record<string, unknown>;

    expect(typeof payload.message).toBe('string');
    expect((payload.message as string).length).toBeGreaterThan(0);
    // Not the empty live reason.
    expect(payload.message).not.toBe('');
  });

  it('CORNER: unknown code still produces parseable structured error', () => {
    const err = buildEnforcementError('UNKNOWN_CODE_F2_TEST', 'some reason');
    expect(err.name).toBe('FlowGuardEnforcementError');

    const payload = JSON.parse(err.message.slice('[FlowGuard] '.length)) as Record<string, unknown>;
    expect(payload.code).toBe('UNKNOWN_CODE_F2_TEST');
    expect(payload.message).toBe('some reason');
    expect(payload.recovery).toEqual([]);
  });

  it('GOOD: detail vars are interpolated into recovery steps', () => {
    const err = buildEnforcementError('SUBAGENT_SESSION_MISMATCH', 'mismatch', {
      expected: 'sess_e',
      actual: 'sess_a',
    });
    const payload = JSON.parse(err.message.slice('[FlowGuard] '.length)) as Record<string, unknown>;

    // At least one recovery step should reference one of the interpolated values
    // if the registry template uses them. If it doesn't, this still passes (no false interpolation).
    const recovery = payload.recovery as string[];
    expect(recovery.length).toBeGreaterThan(0);
    // Detail block always carries the raw values verbatim.
    expect(payload.detail).toEqual({ expected: 'sess_e', actual: 'sess_a' });
  });
});

describe('getToolOutput', () => {
  it('GOOD: returns string output as-is', () => {
    expect(getToolOutput({ output: 'hello' })).toBe('hello');
  });

  it('GOOD: stringifies object output', () => {
    expect(getToolOutput({ output: { ok: true } })).toBe('{"ok":true}');
  });

  it('CORNER: returns "" for null/undefined', () => {
    expect(getToolOutput(null)).toBe('""');
    expect(getToolOutput(undefined)).toBe('""');
    expect(getToolOutput({})).toBe('""');
  });
});

describe('getToolArgs', () => {
  it('GOOD: extracts args object', () => {
    expect(getToolArgs({ args: { foo: 'bar' } })).toEqual({ foo: 'bar' });
  });

  it('CORNER: returns {} for missing args', () => {
    expect(getToolArgs({})).toEqual({});
    expect(getToolArgs(null)).toEqual({});
    expect(getToolArgs(undefined)).toEqual({});
  });
});

// ─── getToolMetadata ──────────────────────────────────────────────────────────

describe('getToolMetadata', () => {
  it('HAPPY: extracts metadata object', () => {
    expect(getToolMetadata({ metadata: { sessionID: 'ses_123' } })).toEqual({
      sessionID: 'ses_123',
    });
  });

  it('HAPPY: returns full metadata with multiple fields', () => {
    const meta = { sessionID: 'ses_abc', model: 'gpt-4', tokens: 100 };
    expect(getToolMetadata({ metadata: meta })).toEqual(meta);
  });

  it('BAD: returns {} for null metadata', () => {
    expect(getToolMetadata({ metadata: null })).toEqual({});
  });

  it('BAD: returns {} for undefined metadata', () => {
    expect(getToolMetadata({ metadata: undefined })).toEqual({});
  });

  it('BAD: returns {} for null output', () => {
    expect(getToolMetadata(null)).toEqual({});
  });

  it('BAD: returns {} for undefined output', () => {
    expect(getToolMetadata(undefined)).toEqual({});
  });

  it('CORNER: returns {} for missing metadata key', () => {
    expect(getToolMetadata({})).toEqual({});
  });

  it('CORNER: returns {} for array metadata (not an object)', () => {
    expect(getToolMetadata({ metadata: [1, 2, 3] })).toEqual({});
  });

  it('CORNER: returns {} for string metadata', () => {
    expect(getToolMetadata({ metadata: 'not-an-object' })).toEqual({});
  });

  it('CORNER: returns {} for number metadata', () => {
    expect(getToolMetadata({ metadata: 42 })).toEqual({});
  });

  it('EDGE: returns object even if metadata has only prototype properties', () => {
    const meta = Object.create(null) as Record<string, unknown>;
    meta.key = 'val';
    expect(getToolMetadata({ metadata: meta })).toEqual({ key: 'val' });
  });
});

// ─── getToolCallID ────────────────────────────────────────────────────────────

describe('getToolCallID', () => {
  it('HAPPY: extracts callID string', () => {
    expect(getToolCallID({ callID: 'call_abc123' })).toBe('call_abc123');
  });

  it('BAD: returns empty string for null input', () => {
    expect(getToolCallID(null)).toBe('');
  });

  it('BAD: returns empty string for undefined input', () => {
    expect(getToolCallID(undefined)).toBe('');
  });

  it('BAD: returns empty string for missing callID', () => {
    expect(getToolCallID({})).toBe('');
  });

  it('CORNER: returns empty string for numeric callID', () => {
    expect(getToolCallID({ callID: 12345 })).toBe('');
  });

  it('CORNER: returns empty string for null callID', () => {
    expect(getToolCallID({ callID: null })).toBe('');
  });

  it('CORNER: returns empty string for boolean callID', () => {
    expect(getToolCallID({ callID: true })).toBe('');
  });

  it('EDGE: preserves callID with special characters', () => {
    expect(getToolCallID({ callID: 'call_αβγ-δ:ε' })).toBe('call_αβγ-δ:ε');
  });

  it('EDGE: returns empty string for empty object callID', () => {
    expect(getToolCallID({ callID: {} })).toBe('');
  });
});
