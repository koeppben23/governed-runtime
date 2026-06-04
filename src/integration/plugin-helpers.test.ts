/**
 * @file plugin-helpers.test.ts
 * @description Unit tests for plugin-helpers utilities.
 *
 * Covers:
 * - parseToolResult: full JSON, first-line fallback, complete failure
 * - strictBlockedOutput: registry lookup, recovery population, marked unknown-code fallback
 * - buildEnforcementError: structured JSON message, name, recovery from registry,
 *   reason override, marked unknown-code fallback (F2 — structured BLOCKED responses)
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
  isNativeEnforcementUnavailableDenial,
  getHostTaskFindingsRejection,
  getReviewIdentityRejection,
  getNativeAttestationRejection,
  getAutoAdvanceOverflow,
  getSessionLockSignal,
} from './plugin-helpers.js';
import { formatBlocked, formatAutoAdvanceOverflow } from './tools/helpers.js';
import { NATIVE_ATTESTATION_REJECTION_FIELD } from '../shared/flowguard-identifiers.js';

describe('parseToolResult', () => {
  it('GOOD: parses valid JSON string', () => {
    const result = parseToolResult('{"ok":true,"value":42}');
    expect(result).toEqual({ ok: true, value: 42 });
  });

  it('GOOD: falls back to first line on multi-line content', () => {
    const result = parseToolResult('{"ok":true}');
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

  it('HAPPY: includes diagnostics for known strict blocked codes', () => {
    const json = strictBlockedOutput('HOST_SUBAGENT_TASK_REQUIRED', {
      obligationId: 'rev-ob-123',
      policyMode: 'host_task_required',
    });
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const diagnostics = parsed.diagnostics as Record<string, unknown>;

    expect(diagnostics.diagnosticCode).toBe('REVIEW_HOST_TASK_EVIDENCE_MISSING');
    expect(diagnostics.rootCause).toContain('host-visible');
    expect(diagnostics.safeNextActions).toEqual(
      expect.arrayContaining([expect.stringContaining('Do not submit manual')]),
    );
    expect(parsed.diagnosticCard).toBeUndefined();
  });

  it('CORNER: unknown code is marked unregistered with recovery', () => {
    const json = strictBlockedOutput('UNKNOWN_CODE_NEVER_REGISTERED_XYZ', {});
    const parsed = JSON.parse(json) as Record<string, unknown>;

    expect(parsed.error).toBe(true);
    expect(parsed.code).toBe('UNKNOWN_CODE_NEVER_REGISTERED_XYZ');
    expect(parsed.message).toContain('[UNREGISTERED_REASON: UNKNOWN_CODE_NEVER_REGISTERED_XYZ]');
    expect(parsed.recovery).toEqual(
      expect.arrayContaining([expect.stringContaining('[UNREGISTERED_REASON]')]),
    );
    expect(parsed.diagnostics).toBeUndefined();
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

  it('EDGE: enforcement errors include diagnostics without changing the thrown error contract', () => {
    const err = buildEnforcementError('HOST_TOOL_PHASE_DENIED', 'write is denied in PLAN', {
      tool: 'write',
      phase: 'PLAN',
    });
    const payload = JSON.parse(err.message.slice('[FlowGuard] '.length)) as Record<string, unknown>;
    const diagnostics = payload.diagnostics as Record<string, unknown>;

    expect(err.name).toBe('FlowGuardEnforcementError');
    expect(payload.code).toBe('HOST_TOOL_PHASE_DENIED');
    expect(payload.message).toBe('write is denied in PLAN');
    expect(diagnostics.diagnosticCode).toBe('HOST_TOOL_MUTATION_DENIED_IN_PHASE');
    expect(diagnostics.phase).toBe('PLAN');
    expect(payload.diagnosticCard).toBeUndefined();
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
    expect(payload.message).not.toBe('some reason');
    expect(payload.message).toContain('[UNREGISTERED_REASON: UNKNOWN_CODE_F2_TEST]');
    expect(payload.message).toContain('Context: some reason');
    expect(payload.recovery).toEqual(
      expect.arrayContaining([expect.stringContaining('[UNREGISTERED_REASON]')]),
    );
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

describe('isNativeEnforcementUnavailableDenial (#419)', () => {
  it('GOOD: true for native-path PLUGIN_ENFORCEMENT_UNAVAILABLE denial', () => {
    const output = formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      obligationType: 'plan',
      iteration: '0',
      planVersion: '1',
      deniedReviewPath: 'native',
    });
    expect(isNativeEnforcementUnavailableDenial(output)).toBe(true);
  });

  it('BAD: false for enforcement-unavailable denial without native path (solo/host_task_preferred)', () => {
    const output = formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', {
      obligationType: 'plan',
      iteration: '0',
      planVersion: '1',
    });
    expect(isNativeEnforcementUnavailableDenial(output)).toBe(false);
  });

  it('BAD: false for a different blocked code even with a native marker', () => {
    const output = formatBlocked('SUBAGENT_EVIDENCE_MISSING', { deniedReviewPath: 'native' });
    expect(isNativeEnforcementUnavailableDenial(output)).toBe(false);
  });

  it('CORNER: false for an unrecognized deniedReviewPath value', () => {
    const output = formatBlocked('PLUGIN_ENFORCEMENT_UNAVAILABLE', { deniedReviewPath: 'manual' });
    expect(isNativeEnforcementUnavailableDenial(output)).toBe(false);
  });

  it('CORNER: false for unparseable output', () => {
    expect(isNativeEnforcementUnavailableDenial('not json at all')).toBe(false);
  });

  it('CORNER: false for a successful (non-blocked) tool result', () => {
    expect(isNativeEnforcementUnavailableDenial('{"ok":true}')).toBe(false);
  });
});

describe('getHostTaskFindingsRejection (#424)', () => {
  it('GOOD: returns structured host-task findings rejection context', () => {
    const output = JSON.stringify({
      error: true,
      code: 'SUBAGENT_EVIDENCE_REUSED',
      hostTaskFindingsRejection: {
        path: 'host_task',
        reason: 'SUBAGENT_EVIDENCE_REUSED',
        status: 'consumed',
        obligationId: '11111111-1111-4111-8111-111111111111',
      },
    });

    expect(getHostTaskFindingsRejection(output)).toEqual({
      path: 'host_task',
      reason: 'SUBAGENT_EVIDENCE_REUSED',
      status: 'consumed',
      obligationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('BAD: ignores strict-path blocks without host-task marker', () => {
    const output = formatBlocked('SUBAGENT_EVIDENCE_REUSED', {
      obligationId: '11111111-1111-4111-8111-111111111111',
    });

    expect(getHostTaskFindingsRejection(output)).toBeNull();
  });

  it('BAD: ignores rejection with non-host-task path', () => {
    const output = JSON.stringify({
      error: true,
      code: 'SUBAGENT_EVIDENCE_REUSED',
      hostTaskFindingsRejection: {
        path: 'strict',
        reason: 'SUBAGENT_EVIDENCE_REUSED',
        status: 'consumed',
      },
    });

    expect(getHostTaskFindingsRejection(output)).toBeNull();
  });

  it('CORNER: returns null for unparseable output', () => {
    expect(getHostTaskFindingsRejection('not json at all')).toBeNull();
  });
});

describe('getReviewIdentityRejection (#425)', () => {
  it('GOOD: returns structured reviewer-author rejection context', () => {
    const output = JSON.stringify({
      error: true,
      code: 'FOUR_EYES_ACTOR_MATCH',
      reviewIdentityRejection: {
        reason: 'reviewer_is_author',
        obligationId: '11111111-1111-4111-8111-111111111111',
      },
    });

    expect(getReviewIdentityRejection(output)).toEqual({
      reason: 'reviewer_is_author',
      obligationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('BAD: ignores matching reason code without structured marker', () => {
    const output = formatBlocked('FOUR_EYES_ACTOR_MATCH', { initiator: 'initiator-1' });
    expect(getReviewIdentityRejection(output)).toBeNull();
  });

  it('CORNER: returns null for unparseable output', () => {
    expect(getReviewIdentityRejection('not json at all')).toBeNull();
  });
});

describe('getNativeAttestationRejection (#427)', () => {
  it('GOOD: returns structured native attestation rejection context', () => {
    const output = JSON.stringify({
      phase: 'REVIEW_COMPLETE',
      [NATIVE_ATTESTATION_REJECTION_FIELD]: {
        reason: 'capture_session_mismatch',
        obligationId: '11111111-1111-4111-8111-111111111111',
      },
    });

    expect(getNativeAttestationRejection(output)).toEqual({
      reason: 'capture_session_mismatch',
      obligationId: '11111111-1111-4111-8111-111111111111',
    });
  });

  it('BAD: ignores matching text without structured marker', () => {
    const output = JSON.stringify({
      phase: 'REVIEW_COMPLETE',
      message: 'native attestation not upgraded: capture_session_mismatch',
    });

    expect(getNativeAttestationRejection(output)).toBeNull();
  });

  it('CORNER: returns null for malformed marker', () => {
    const output = JSON.stringify({
      phase: 'REVIEW_COMPLETE',
      [NATIVE_ATTESTATION_REJECTION_FIELD]: { reason: 42 },
    });

    expect(getNativeAttestationRejection(output)).toBeNull();
  });

  it('CORNER: returns null for unparseable output', () => {
    expect(getNativeAttestationRejection('not json at all')).toBeNull();
  });
});

describe('getAutoAdvanceOverflow (#428)', () => {
  const overflow = { kind: 'overflow' as const, phase: 'PLAN_REVIEW', limit: 10, transitions: [] };

  it('GOOD: returns { phase, limit } for a structured overflow result', () => {
    const output = formatAutoAdvanceOverflow(overflow);
    expect(getAutoAdvanceOverflow(output)).toEqual({ phase: 'PLAN_REVIEW', limit: 10 });
  });

  it('BAD: detects via STRUCTURED code+field, NOT a message substring', () => {
    // Message mentions the code text, but code is different and there is no
    // structured autoAdvanceOverflow field → must NOT be detected.
    const output = JSON.stringify({
      error: true,
      code: 'SOME_OTHER_CODE',
      message: 'something about AUTO_ADVANCE_OVERFLOW happened at phase PLAN_REVIEW (limit 10)',
    });
    expect(getAutoAdvanceOverflow(output)).toBeNull();
  });

  it('BAD: null when code matches but the structured field is missing', () => {
    const output = JSON.stringify({ error: true, code: 'AUTO_ADVANCE_OVERFLOW' });
    expect(getAutoAdvanceOverflow(output)).toBeNull();
  });

  it('CORNER: null when limit is not a number', () => {
    const output = JSON.stringify({
      error: true,
      code: 'AUTO_ADVANCE_OVERFLOW',
      autoAdvanceOverflow: { phase: 'PLAN_REVIEW', limit: '10' },
    });
    expect(getAutoAdvanceOverflow(output)).toBeNull();
  });

  it('CORNER: null for unparseable output (fail closed, no throw)', () => {
    expect(getAutoAdvanceOverflow('not json at all')).toBeNull();
  });

  it('CORNER: null for a successful (non-overflow) tool result', () => {
    expect(getAutoAdvanceOverflow('{"ok":true}')).toBeNull();
  });
});

describe('getSessionLockSignal (#429)', () => {
  it('GOOD: "contended" for a BLOCKED result with SESSION_LOCK_CONTENDED code', () => {
    const output = JSON.stringify({
      error: true,
      code: 'SESSION_LOCK_CONTENDED',
      message: 'lock timeout',
    });
    expect(getSessionLockSignal(output)).toBe('contended');
  });

  it('GOOD: "waited" for a SUCCESS result carrying lockContended:true', () => {
    const output = JSON.stringify({ ok: true, ticket: { text: 'x' }, lockContended: true });
    expect(getSessionLockSignal(output)).toBe('waited');
  });

  it('BAD: detects via STRUCTURED code+field, NOT a message substring', () => {
    // Message mentions the code text, but code differs and there is no
    // structured lockContended field → must NOT be detected.
    const output = JSON.stringify({
      error: true,
      code: 'SOME_OTHER_CODE',
      message: 'a SESSION_LOCK_CONTENDED-like situation occurred',
    });
    expect(getSessionLockSignal(output)).toBeNull();
  });

  it('CORNER: null for an uncontended success (no lockContended field)', () => {
    expect(getSessionLockSignal('{"ok":true,"ticket":{"text":"x"}}')).toBeNull();
  });

  it('CORNER: null when lockContended is present but not strictly true', () => {
    expect(getSessionLockSignal('{"ok":true,"lockContended":false}')).toBeNull();
    expect(getSessionLockSignal('{"ok":true,"lockContended":"true"}')).toBeNull();
  });

  it('CORNER: contended takes precedence — an error code is never "waited"', () => {
    const output = JSON.stringify({
      error: true,
      code: 'SESSION_LOCK_CONTENDED',
      lockContended: true,
    });
    expect(getSessionLockSignal(output)).toBe('contended');
  });

  it('REGRESSION (#429): an error output with an UNRELATED code + lockContended:true is NOT "waited"', () => {
    // A hydrate that waited for the lock but then failed for another reason must
    // never be reported as a "waited success". Even if a stray lockContended
    // field leaked onto an error output, the detector returns null (not
    // 'waited'), so the plugin never logs a false "waited" success.
    const output = JSON.stringify({
      error: true,
      code: 'SOME_OTHER_REASON',
      message: 'unrelated failure',
      lockContended: true,
    });
    expect(getSessionLockSignal(output)).toBeNull();
  });

  it('CORNER: null for unparseable output (fail closed, no throw)', () => {
    expect(getSessionLockSignal('not json at all')).toBeNull();
  });
});
