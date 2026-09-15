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

const { mockOnFlowGuardToolAfter } = vi.hoisted(() => ({
  mockOnFlowGuardToolAfter: vi.fn(),
}));

vi.mock('./review/enforcement/enforcement.js', () => ({
  onFlowGuardToolAfter: (...args: unknown[]) => mockOnFlowGuardToolAfter(...args),
}));

import { trackFlowGuardEnforcement } from './plugin-enforcement-tracking.js';
import type {
  SessionEnforcementState,
  PendingReviewTool,
  PendingReview,
} from './review/enforcement/types.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeEState(): SessionEnforcementState {
  return {
    pendingReviews: new Map<PendingReviewTool, PendingReview>(),
  };
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
