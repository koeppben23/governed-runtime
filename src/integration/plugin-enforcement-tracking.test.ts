/**
 * @module integration/plugin-enforcement-tracking.test
 * @description Direct tests for plugin enforcement tracking module.
 *
 * Verifies the thin extraction+delegation layer between OpenCode runtime hooks
 * and the review enforcement engine. Each test validates that the correct
 * arguments are extracted and forwarded, and that delegation errors propagate.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ─── Mocks ──────────────────────────────────────────────────────────────────

const { mockOnFlowGuardToolAfter, mockOnTaskToolAfter } = vi.hoisted(() => ({
  mockOnFlowGuardToolAfter: vi.fn(),
  mockOnTaskToolAfter: vi.fn(),
}));

vi.mock('./review/enforcement/enforcement.js', () => ({
  onFlowGuardToolAfter: (...args: unknown[]) => mockOnFlowGuardToolAfter(...args),
  onTaskToolAfter: (...args: unknown[]) => mockOnTaskToolAfter(...args),
}));

import { trackFlowGuardEnforcement, trackTaskEnforcement } from './plugin-enforcement-tracking.js';
import type {
  SessionEnforcementState,
  PendingReviewTool,
  PendingReview,
} from './review/enforcement/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEState(): SessionEnforcementState {
  return { pendingReviews: new Map<PendingReviewTool, PendingReview>() };
}

const FIXED_NOW = '2026-05-15T12:00:00.000Z';

// ─── trackFlowGuardEnforcement ──────────────────────────────────────────────

describe('trackFlowGuardEnforcement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ─── HAPPY ─────────────────────────────────────────────────

  it('extracts args and output and delegates to onFlowGuardToolAfter', () => {
    const eState = makeEState();
    const input = { tool: 'flowguard_plan', sessionID: 's1', callID: 'c1', args: { key: 'val' } };
    const output = { title: 'Plan', output: 'plan result text' };

    trackFlowGuardEnforcement(eState, 'flowguard_plan', input, output, FIXED_NOW);

    expect(mockOnFlowGuardToolAfter).toHaveBeenCalledTimes(1);
    expect(mockOnFlowGuardToolAfter).toHaveBeenCalledWith(
      eState,
      'flowguard_plan',
      { key: 'val' },
      'plan result text',
      FIXED_NOW,
    );
  });

  it('forwards toolName unchanged so enforcement module can decide', () => {
    const eState = makeEState();
    const input = { args: {} };
    const output = { output: '{}' };

    trackFlowGuardEnforcement(eState, 'flowguard_review', input, output, FIXED_NOW);

    expect(mockOnFlowGuardToolAfter).toHaveBeenCalledWith(
      eState,
      'flowguard_review',
      expect.any(Object),
      expect.any(String),
      FIXED_NOW,
    );
  });

  // ─── BAD ───────────────────────────────────────────────────

  it('propagates error when onFlowGuardToolAfter throws', () => {
    const eState = makeEState();
    mockOnFlowGuardToolAfter.mockImplementation(() => {
      throw new Error('enforcement failure');
    });

    expect(() =>
      trackFlowGuardEnforcement(eState, 'flowguard_plan', { args: {} }, { output: 'x' }, FIXED_NOW),
    ).toThrow('enforcement failure');
  });

  it('delegates with args = {} when input has no args field', () => {
    const eState = makeEState();
    const input = { tool: 'flowguard_plan', sessionID: 's1' } as unknown as Record<string, unknown>;

    trackFlowGuardEnforcement(eState, 'flowguard_plan', input, { output: 'text' }, FIXED_NOW);

    expect(mockOnFlowGuardToolAfter).toHaveBeenCalledWith(
      eState,
      'flowguard_plan',
      {},
      'text',
      FIXED_NOW,
    );
  });

  it('delegates with rawOutput = JSON-stringified fallback when output has no output field', () => {
    const eState = makeEState();
    const outputObj = { title: 'Plan' } as unknown as Record<string, unknown>;

    trackFlowGuardEnforcement(eState, 'flowguard_plan', { args: { x: 1 } }, outputObj, FIXED_NOW);

    // getToolOutput JSON.stringifies the fallback when output field is absent
    expect(mockOnFlowGuardToolAfter).toHaveBeenCalledWith(
      eState,
      'flowguard_plan',
      { x: 1 },
      '""',
      FIXED_NOW,
    );
  });

  // ─── CORNER ────────────────────────────────────────────────

  it('delegates even when toolName is empty string (enforcement module decides)', () => {
    const eState = makeEState();

    trackFlowGuardEnforcement(eState, '', { args: {} }, { output: 'x' }, FIXED_NOW);

    expect(mockOnFlowGuardToolAfter).toHaveBeenCalledWith(
      eState,
      '',
      expect.any(Object),
      expect.any(String),
      FIXED_NOW,
    );
  });
});

// ─── trackTaskEnforcement ───────────────────────────────────────────────────

describe('trackTaskEnforcement', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // ─── HAPPY ─────────────────────────────────────────────────

  it('extracts args, output, metadata, callID and delegates with TaskToolContext', () => {
    const eState = makeEState();
    const input = {
      tool: 'task',
      sessionID: 's1',
      callID: 'call-abc-123',
      args: { subagent_type: 'flowguard-reviewer' },
    };
    const output = {
      title: 'Task',
      output: 'task result',
      metadata: { sessionID: 'child-session-1', foo: 'bar' },
    };

    trackTaskEnforcement(eState, input, output, FIXED_NOW);

    expect(mockOnTaskToolAfter).toHaveBeenCalledTimes(1);
    expect(mockOnTaskToolAfter).toHaveBeenCalledWith(
      eState,
      { subagent_type: 'flowguard-reviewer' },
      'task result',
      FIXED_NOW,
      { metadata: { sessionID: 'child-session-1', foo: 'bar' }, callID: 'call-abc-123' },
    );
  });

  it('forwards callID and metadata without normalization (BUG-14 guard)', () => {
    const eState = makeEState();
    const uniqueCallID = 'unusual-call-id-!@#$%';
    const nestedMetadata = { sessionID: 'sess-nested', deep: { key: 'val' } };
    const input = { callID: uniqueCallID, args: {} };
    const output = { output: 'ok', metadata: nestedMetadata };

    trackTaskEnforcement(eState, input, output, FIXED_NOW);

    expect(mockOnTaskToolAfter).toHaveBeenCalledWith(
      eState,
      expect.any(Object),
      expect.any(String),
      FIXED_NOW,
      { metadata: nestedMetadata, callID: uniqueCallID },
    );
  });

  // ─── BAD ───────────────────────────────────────────────────

  it('propagates error when onTaskToolAfter throws', () => {
    const eState = makeEState();
    mockOnTaskToolAfter.mockImplementation(() => {
      throw new Error('task enforcement failure');
    });

    expect(() => trackTaskEnforcement(eState, { args: {} }, { output: 'x' }, FIXED_NOW)).toThrow(
      'task enforcement failure',
    );
  });

  // ─── CORNER ────────────────────────────────────────────────

  it('passes metadata = {} in TaskToolContext when output metadata is absent', () => {
    const eState = makeEState();
    const input = { callID: 'c1', args: {} };
    const output = { output: 'text' };

    trackTaskEnforcement(eState, input, output, FIXED_NOW);

    expect(mockOnTaskToolAfter).toHaveBeenCalledWith(
      eState,
      expect.any(Object),
      expect.any(String),
      FIXED_NOW,
      { metadata: {}, callID: 'c1' },
    );
  });

  it('passes callID = "" in TaskToolContext when input has no callID', () => {
    const eState = makeEState();
    const input = { args: {} };
    const output = { output: 'text', metadata: {} };

    trackTaskEnforcement(eState, input, output, FIXED_NOW);

    expect(mockOnTaskToolAfter).toHaveBeenCalledWith(
      eState,
      expect.any(Object),
      expect.any(String),
      FIXED_NOW,
      { metadata: {}, callID: '' },
    );
  });
});
