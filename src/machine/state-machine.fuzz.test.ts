/**
 * @module machine/state-machine.fuzz.test
 * @description Property-based fuzz tests for the FlowGuard state machine.
 *
 * Uses the TRANSITIONS topology map to randomly pick valid events from
 * the current phase, covering all event types including REJECT,
 * CHANGES_REQUESTED, CHECK_FAILED, REVIEW_PENDING, etc.
 *
 * Invariants:
 * - evaluate() never returns undefined for valid SessionState
 * - evalResult.kind is always a valid discriminant
 * - error !== null forces ERROR self-loop in guard-based phases
 * - terminal phases return kind: 'terminal'
 * - transitions never produce invalid phases
 *
 * run control:
 *   FAST_CHECK_NUM_RUNS=100 npx vitest run --project fuzz
 *   FAST_CHECK_SEED=12345 npx vitest run --project fuzz
 *
 * @see https://github.com/koeppben23/governed-runtime/issues/347
 */

import { describe, it, expect } from 'vitest';
import * as fc from 'fast-check';
import { evaluate } from './evaluate.js';
import { TRANSITIONS, resolveTransition, TERMINAL } from './topology.js';
import type { Phase, Event, SessionState } from '../state/schema.js';
import { makeState } from '../__fixtures__.js';

const ALL_PHASES: Phase[] = [
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

const POLICY_MODES = ['solo', 'team', 'regulated'] as const;

describe('state machine fuzz', () => {
  it('evaluate never returns undefined and respects transition topology with random valid events', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ALL_PHASES),
        fc.constantFrom(...POLICY_MODES),
        fc.integer({ min: 1, max: 25 }),
        fc.integer({ min: 0, max: 9999 }),
        (startPhase, mode, steps, eventSeed) => {
          let phase: Phase = startPhase;
          const policy = { requireHumanGates: mode !== 'solo' };

          for (let i = 0; i < steps && !TERMINAL.has(phase); i++) {
            const state = makeState(phase) as SessionState;
            const result = evaluate(state, policy);
            expect(result).toBeDefined();
            expect(['transition', 'waiting', 'terminal', 'pending']).toContain(result.kind);

            if (result.kind === 'terminal') break;
            if (result.kind === 'waiting' || result.kind === 'pending') {
              // For waiting/pending phases, pick a random valid event from the topology.
              const validEvents = TRANSITIONS.get(phase);
              if (validEvents && validEvents.size > 0) {
                const eventList = [...validEvents.keys()];
                const pick = eventList[(eventSeed + i) % eventList.length]!;
                const target = resolveTransition(phase, pick);
                if (!target) break;
                phase = target;
              } else {
                break;
              }
            } else {
              // kind === 'transition'
              const target = resolveTransition(phase, result.event);
              if (!target) break;
              phase = target;
            }
          }
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('error field forces ERROR self-loop in guard-based phases', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'TICKET',
          'PLAN',
          'VALIDATION',
          'IMPLEMENTATION',
          'IMPL_REVIEW',
          'ARCHITECTURE',
          'REVIEW' as Phase,
        ),
        (phase) => {
          const state = makeState(phase, {
            error: {
              code: 'TEST_ERROR',
              message: 'fuzz error',
              recoveryHint: 'none',
              occurredAt: new Date().toISOString(),
            },
          }) as SessionState;

          const result = evaluate(state, {});
          expect(result.kind).toBe('transition');
          if (result.kind === 'transition') {
            expect(result.event).toBe('ERROR');
          }
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('terminal phases return kind: terminal', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE' as Phase),
        (phase) => {
          const state = makeState(phase) as SessionState;
          const result = evaluate(state, {});
          expect(result.kind).toBe('terminal');
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('user gates block when requireHumanGates is true', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW' as Phase),
        (phase) => {
          const state = makeState(phase) as SessionState;
          const result = evaluate(state, { requireHumanGates: true });
          expect(result.kind).toBe('waiting');
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('user gates auto-approve when requireHumanGates is false', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW' as Phase),
        (phase) => {
          const state = makeState(phase) as SessionState;
          const result = evaluate(state, { requireHumanGates: false });
          expect(result.kind).toBe('transition');
          if (result.kind === 'transition') {
            expect(result.event).toBe('APPROVE');
          }
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('all valid topology transitions resolve to a known Phase', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_PHASES.filter((p) => TRANSITIONS.has(p))), (phase) => {
        const validEvents = TRANSITIONS.get(phase)!;
        for (const event of validEvents.keys()) {
          const target = resolveTransition(phase, event);
          expect(target).toBeDefined();
          expect(ALL_PHASES).toContain(target!);
        }
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('REJECT and CHANGES_REQUESTED resolve to expected backward phases', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW' as Phase),
        (gatePhase) => {
          // REJECT always goes far backward.
          const rejectTarget = resolveTransition(gatePhase, 'REJECT');
          expect(rejectTarget).toBeDefined();
          // CHANGES_REQUESTED goes one step backward.
          const crTarget = resolveTransition(gatePhase, 'CHANGES_REQUESTED');
          expect(crTarget).toBeDefined();

          // Both targets must be valid phases.
          expect(ALL_PHASES).toContain(rejectTarget!);
          expect(ALL_PHASES).toContain(crTarget!);

          // REJECT and CHANGES_REQUESTED should resolve to different targets
          // (different reversal distance).
          if (gatePhase !== 'ARCH_REVIEW') {
            // PLAN_REVIEW and EVIDENCE_REVIEW: REJECT goes further than CHANGES_REQUESTED.
            expect(rejectTarget).not.toBe(crTarget);
          }
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('CHECK_FAILED and REVIEW_PENDING resolve to valid phases', () => {
    fc.assert(
      fc.property(fc.constantFrom('VALIDATION', 'IMPL_REVIEW' as Phase), (phase) => {
        const events = TRANSITIONS.get(phase)!;
        for (const eventName of ['CHECK_FAILED', 'REVIEW_PENDING'] as const) {
          if (events.has(eventName)) {
            const target = resolveTransition(phase, eventName);
            expect(target).toBeDefined();
            expect(ALL_PHASES).toContain(target!);
          }
        }
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });
});
