/**
 * @test-policy
 * HAPPY: every Phase has a human-readable label.
 * HAPPY: no label is SCREAMING_SNAKE_CASE.
 * CORNER: labels are non-empty strings.
 * EDGE: TypeScript compile-time exhaustiveness via `satisfies Record<Phase, string>`.
 * PERF: not applicable; compile-time check only.
 */
import { describe, expect, it } from 'vitest';
import { PHASE_LABELS } from './phase-labels.js';
import type { Phase } from '../state/schema.js';

const ALL_PHASES: readonly Phase[] = [
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'REVIEW',
  'REVIEW_COMPLETE',
];

describe('PHASE_LABELS', () => {
  it('has a label for every phase (exhaustiveness)', () => {
    for (const phase of ALL_PHASES) {
      expect(PHASE_LABELS[phase], `Phase "${phase}" must have a label`).toBeTypeOf('string');
    }
  });

  it('no label is SCREAMING_SNAKE_CASE', () => {
    const screaming = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*$/;
    for (const [phase, label] of Object.entries(PHASE_LABELS) as [Phase, string][]) {
      expect(
        screaming.test(label),
        `Phase "${phase}" label "${label}" must not be SCREAMING_SNAKE_CASE`,
      ).toBe(false);
    }
  });

  it('every label is a non-empty string', () => {
    for (const [phase, label] of Object.entries(PHASE_LABELS) as [Phase, string][]) {
      expect(label.length, `Phase "${phase}" label must not be empty`).toBeGreaterThan(0);
    }
  });

  it('label count matches phase count', () => {
    expect(Object.keys(PHASE_LABELS)).toHaveLength(ALL_PHASES.length);
  });

  it('each phase maps to the correct product-oriented label', () => {
    expect(PHASE_LABELS.READY).toBe('Ready');
    expect(PHASE_LABELS.TICKET).toBe('Task captured');
    expect(PHASE_LABELS.PLAN).toBe('Planning');
    expect(PHASE_LABELS.PLAN_REVIEW).toBe('Ready for plan approval');
    expect(PHASE_LABELS.VALIDATION).toBe('Validation');
    expect(PHASE_LABELS.IMPLEMENTATION).toBe('Implementation in progress');
    expect(PHASE_LABELS.IMPL_REVIEW).toBe('Ready for evidence review');
    expect(PHASE_LABELS.EVIDENCE_REVIEW).toBe('Ready for final review');
    expect(PHASE_LABELS.COMPLETE).toBe('Complete');
    expect(PHASE_LABELS.ARCHITECTURE).toBe('Architecture in progress');
    expect(PHASE_LABELS.ARCH_REVIEW).toBe('Ready for architecture review');
    expect(PHASE_LABELS.ARCH_COMPLETE).toBe('Architecture complete');
    expect(PHASE_LABELS.REVIEW).toBe('Compliance review');
    expect(PHASE_LABELS.REVIEW_COMPLETE).toBe('Review complete');
  });
});
