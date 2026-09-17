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
import { makeState } from '../fixtures.js';

const ALL_PHASES: Phase[] = [
  'READY',
  'TICKET',
  'PLAN',
  'PLAN_REVIEW',
  'VALIDATION',
  'IMPLEMENTATION',
  'IMPL_VALIDATION',
  'IMPL_REVIEW',
  'EVIDENCE_REVIEW',
  'EXPORT_READY',
  'COMPLETE',
  'ARCHITECTURE',
  'ARCH_REVIEW',
  'ARCH_COMPLETE',
  'PEER_REVIEW',
  'PEER_REVIEW_COMPLETE',
  'REJECTED',
  'ABORTED',
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
            const state = makeState(phase);
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
          'PEER_REVIEW' as Phase,
        ),
        (phase) => {
          const state = makeState(phase, {
            error: {
              code: 'TEST_ERROR',
              message: 'fuzz error',
              recoveryHint: 'none',
              occurredAt: new Date().toISOString(),
            },
          });

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
        fc.constantFrom(
          'COMPLETE',
          'ARCH_COMPLETE',
          'PEER_REVIEW_COMPLETE',
          'REJECTED',
          'ABORTED' as Phase,
        ),
        (phase) => {
          const state = makeState(phase);
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
          const state = makeState(phase);
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

  it('solo mode auto-approves only plan and evidence gates', () => {
    fc.assert(
      fc.property(fc.constantFrom('PLAN_REVIEW', 'EVIDENCE_REVIEW' as Phase), (phase) => {
        const state = makeState(phase);
        const result = evaluate(state, { requireHumanGates: false });
        expect(result.kind).toBe('transition');
        if (result.kind === 'transition') {
          expect(result.event).toBe('APPROVE');
        }
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('architecture review always waits for an explicit human decision', () => {
    fc.assert(
      fc.property(fc.boolean(), (requireHumanGates) => {
        const result = evaluate(makeState('ARCH_REVIEW'), { requireHumanGates });
        expect(result.kind).toBe('waiting');
      }),
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

  it('REJECT ends the workflow at REJECTED and CHANGES_REQUESTED returns to revision', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW' as Phase),
        (gatePhase) => {
          // REJECT terminates the governed workflow at the dedicated terminal.
          const rejectTarget = resolveTransition(gatePhase, 'REJECT');
          expect(rejectTarget).toBe('REJECTED');
          expect(TERMINAL.has(rejectTarget!)).toBe(true);

          // CHANGES_REQUESTED returns to the subject's revision position.
          const crTarget = resolveTransition(gatePhase, 'CHANGES_REQUESTED');
          expect(crTarget).toBeDefined();
          expect(['PLAN', 'IMPLEMENTATION', 'ARCHITECTURE']).toContain(crTarget!);
          expect(crTarget).not.toBe(rejectTarget);
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

  it('ABORT resolves to ABORTED from every non-terminal phase and fails closed at terminals', () => {
    fc.assert(
      fc.property(fc.constantFrom(...ALL_PHASES), (phase) => {
        const target = resolveTransition(phase, 'ABORT');
        if (TERMINAL.has(phase)) {
          // Already terminal: abort is a no-op, never a second transition.
          expect(target).toBeUndefined();
        } else {
          expect(target).toBe('ABORTED');
        }
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('EXPORT_READY completes only through EXPORT_MATERIALIZED', () => {
    const events = TRANSITIONS.get('EXPORT_READY')!;
    expect([...events.keys()].sort()).toEqual(['ABORT', 'EXPORT_MATERIALIZED']);
    expect(resolveTransition('EXPORT_READY', 'EXPORT_MATERIALIZED')).toBe('COMPLETE');
    expect(resolveTransition('EXPORT_READY', 'ABORT')).toBe('ABORTED');
    // No approval or validation event may complete the workflow directly.
    for (const event of [
      'APPROVE',
      'CHANGES_REQUESTED',
      'ALL_PASSED',
      'IMPL_COMPLETE',
    ] as Event[]) {
      expect(resolveTransition('EXPORT_READY', event)).toBeUndefined();
    }
  });

  it('REVIEW_EXHAUSTED routes the exhausted implementation loop to the final gate', () => {
    expect(resolveTransition('IMPL_REVIEW', 'REVIEW_EXHAUSTED')).toBe('EVIDENCE_REVIEW');
    // Ordinary convergence still routes to the same gate; exhaustion changes the
    // gate type via the directive, never the topology target.
    expect(resolveTransition('IMPL_REVIEW', 'REVIEW_MET')).toBe('EVIDENCE_REVIEW');
  });

  it('flow-selection events (TICKET_SELECTED, ARCHITECTURE_SELECTED, REVIEW_SELECTED) resolve from READY', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'TICKET_SELECTED',
          'ARCHITECTURE_SELECTED',
          'PEER_REVIEW_SELECTED' as Event,
        ),
        (event) => {
          const target = resolveTransition('READY', event);
          expect(target).toBeDefined();
          expect(['TICKET', 'ARCHITECTURE', 'PEER_REVIEW']).toContain(target!);
        },
      ),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });

  it('REDUCED_CEREMONY and IMPL_COMPLETE resolve from IMPLEMENTATION', () => {
    fc.assert(
      fc.property(fc.constantFrom('REDUCED_CEREMONY', 'IMPL_COMPLETE' as Event), (event) => {
        const target = resolveTransition('IMPLEMENTATION', event);
        expect(target).toBeDefined();
        expect(['IMPL_VALIDATION', 'EVIDENCE_REVIEW']).toContain(target!);
      }),
      {
        numRuns: Number(process.env.FAST_CHECK_NUM_RUNS) || 100,
        seed: Number(process.env.FAST_CHECK_SEED ?? '12345'),
        endOnFailure: true,
      },
    );
  });
});
