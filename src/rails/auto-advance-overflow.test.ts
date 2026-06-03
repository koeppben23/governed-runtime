/**
 * @module rails/auto-advance-overflow.test
 * @description Negative-path coverage for the auto-advance overflow → fail-closed
 * block mapper (#428). Asserts the mapper emits the canonical AUTO_ADVANCE_OVERFLOW
 * code with structured { phase, limit } context, carries NO advanced state, and is
 * the single authority for the overflow → block decision.
 */

import { describe, it, expect } from 'vitest';
import { blockedFromOverflow, AUTO_ADVANCE_OVERFLOW_CODE } from './auto-advance-overflow.js';
import type { AutoAdvanceOverflow } from './types.js';

describe('rails/auto-advance-overflow', () => {
  const overflow: AutoAdvanceOverflow = {
    kind: 'overflow',
    phase: 'PLAN_REVIEW',
    limit: 10,
    transitions: [],
  };

  it('GOOD: maps an overflow to a blocked result with the canonical code', () => {
    const result = blockedFromOverflow(overflow);
    expect(result.kind).toBe('blocked');
    expect(result.code).toBe(AUTO_ADVANCE_OVERFLOW_CODE);
    expect(result.code).toBe('AUTO_ADVANCE_OVERFLOW');
  });

  it('GOOD: attaches structured { phase, limit } context for the plugin boundary', () => {
    const result = blockedFromOverflow(overflow);
    expect(result.overflow).toEqual({ phase: 'PLAN_REVIEW', limit: 10 });
  });

  it('FAIL-CLOSED: the blocked result carries no advanced state or evalResult', () => {
    const result = blockedFromOverflow(overflow) as Record<string, unknown>;
    expect(result.state).toBeUndefined();
    expect(result.evalResult).toBeUndefined();
  });

  it('interpolates phase and limit into the human-readable reason', () => {
    const result = blockedFromOverflow(overflow);
    expect(result.reason).toContain('PLAN_REVIEW');
    expect(result.reason).toContain('10');
  });
});
