/**
 * @module config/reasons-subagent-unable.test
 * @description Targeted contract tests for the SUBAGENT_UNABLE_TO_REVIEW
 * blocked-reason entry introduced in P1.3 slice 2.
 *
 * The reason supports the third reviewer-subagent verdict 'unable_to_review'
 * (see LoopVerdict in src/state/evidence.ts). Slice 4c routes this verdict
 * through strictBlockedOutput using this code; that wiring is covered in
 * slice 4c. Here we only verify the registry contract:
 *
 * 1. The code is registered in the default registry.
 * 2. It has non-empty recovery steps (build-time guard symmetry).
 * 3. The category is 'state' (tool-failure, not user-input).
 * 4. The {obligationId} and {reason} interpolation variables resolve.
 * 5. There is NO quickFixCommand — recovery requires a fresh /plan or
 *    /implement submission, which is a deliberate reset, not a one-tap fix.
 * 6. The recovery messaging explicitly forbids retry of the same submission
 *    (anti-fabrication-by-retry rail).
 */

import { describe, expect, it } from 'vitest';

import { blocked, defaultReasonRegistry } from './reasons.js';

describe('SUBAGENT_UNABLE_TO_REVIEW (P1.3 slice 2)', () => {
  it('GOOD: is registered in the default registry', () => {
    const reason = defaultReasonRegistry.get('SUBAGENT_UNABLE_TO_REVIEW');
    expect(reason).toBeDefined();
  });

  it('GOOD: is categorized as "state" (tool-failure, not user-input)', () => {
    const reason = defaultReasonRegistry.get('SUBAGENT_UNABLE_TO_REVIEW');
    expect(reason?.category).toBe('state');
  });

  it('GOOD: has non-empty recovery steps (registry completeness guard)', () => {
    const formatted = defaultReasonRegistry.format('SUBAGENT_UNABLE_TO_REVIEW');
    expect(formatted.recovery.length).toBeGreaterThan(0);
    for (const step of formatted.recovery) {
      expect(step.trim().length).toBeGreaterThan(0);
    }
  });

  it('GOOD: interpolates {obligationId} and {reason} variables', () => {
    const formatted = defaultReasonRegistry.format('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: 'obl_abc123',
      reason: 'plan text empty',
    });
    expect(formatted.reason).toContain('obl_abc123');
    expect(formatted.reason).toContain('plan text empty');
    expect(formatted.reason).not.toContain('{obligationId}');
    expect(formatted.reason).not.toContain('{reason}');
  });

  it('GOOD: blocked() helper produces a structurally-valid RailBlocked', () => {
    const result = blocked('SUBAGENT_UNABLE_TO_REVIEW', {
      obligationId: 'obl_xyz',
      reason: 'mandate digest mismatch',
    });
    expect(result.kind).toBe('blocked');
    expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
    expect(result.reason).toContain('obl_xyz');
    expect(result.recovery.length).toBeGreaterThan(0);
  });

  it('CORNER: recovery explicitly forbids retry of the same submission', () => {
    // Anti-fabrication rail: once the reviewer has emitted unable_to_review,
    // resubmitting the same plan/impl text would invite the agent to keep
    // hammering until it gets approve/changes_requested. The recovery copy
    // must steer the user toward a fresh submission instead.
    const formatted = defaultReasonRegistry.format('SUBAGENT_UNABLE_TO_REVIEW');
    const joined = formatted.recovery.join(' ').toLowerCase();
    expect(joined).toMatch(/do not retry|do not re-submit|do not resubmit|do not try again/);
    expect(joined).toMatch(/fresh|new|reset/);
  });

  it('CORNER: has NO quickFixCommand — recovery is a deliberate reset, not a one-tap fix', () => {
    const reason = defaultReasonRegistry.get('SUBAGENT_UNABLE_TO_REVIEW');
    expect(reason?.quickFixCommand).toBeUndefined();
  });

  it('EDGE: format() with no vars leaves placeholders visible (debuggability)', () => {
    // The interpolate() helper deliberately leaves unknown placeholders
    // as-is so missing variables surface in output instead of silently
    // disappearing. Confirm that contract holds for this reason too.
    const formatted = defaultReasonRegistry.format('SUBAGENT_UNABLE_TO_REVIEW');
    expect(formatted.reason).toContain('{obligationId}');
    expect(formatted.reason).toContain('{reason}');
  });
});
