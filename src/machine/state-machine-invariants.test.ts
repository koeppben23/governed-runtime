import { describe, it, expect } from 'vitest';
import { makeProgressedState } from '../__fixtures__.js';
import type { Phase } from '../state/schema.js';
import { evaluate } from './evaluate.js';
import { resolveNextAction } from './next-action.js';
import { Command, isCommandAllowed } from './commands.js';
import { executeReviewDecision } from '../rails/review-decision.js';
import { resolvePolicy } from '../config/policy.js';
import { USER_GATES } from './topology.js';

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

const TERMINAL_PHASES: Phase[] = ['COMPLETE', 'ARCH_COMPLETE', 'REVIEW_COMPLETE'];

const ALL_COMMANDS: Command[] = Object.values(Command);

const POLICY_MODES = ['solo', 'team', 'team-ci', 'regulated'] as const;

describe('state machine invariants', () => {
  describe('HAPPY/CORNER — terminal phases block mutating commands', () => {
    for (const phase of TERMINAL_PHASES) {
      it(`${phase} blocks all commands`, () => {
        for (const cmd of ALL_COMMANDS) {
          expect(isCommandAllowed(phase, cmd)).toBe(false);
        }
      });
    }
  });

  describe('BAD — blocked rails never advance phase', () => {
    for (const phase of ALL_PHASES) {
      it(`${phase}: blocked review-decision does not mutate phase`, () => {
        const state = makeProgressedState(phase);
        const beforePhase = state.phase;

        const result = executeReviewDecision(
          state,
          {
            verdict: 'approve',
            rationale: 'invariant test',
            decidedBy: 'reviewer-1',
            decisionIdentity: {
              actorId: 'reviewer-1',
              actorEmail: 'reviewer@example.com',
              actorSource: 'claim',
              actorAssurance: 'claim_validated',
            },
          },
          {
            now: () => '2026-04-29T00:00:00.000Z',
            digest: (text) => text,
            policy: resolvePolicy('team'),
          },
        );

        if (USER_GATES.has(phase)) {
          expect(result.kind).toBe('ok');
        } else {
          expect(result.kind).toBe('blocked');
        }
        expect(state.phase).toBe(beforePhase);
      });
    }
  });

  describe('HAPPY/EDGE — evaluate and next-action are deterministic', () => {
    for (const phase of ALL_PHASES) {
      it(`${phase}: repeated evaluate(...) and resolveNextAction(...) are identical`, () => {
        const state = makeProgressedState(phase);
        const policy = resolvePolicy('team');

        const evalA = evaluate(state, policy);
        const evalB = evaluate(state, policy);
        const evalC = evaluate(state, policy);

        expect(evalA).toEqual(evalB);
        expect(evalB).toEqual(evalC);

        const actionA = resolveNextAction(phase, state);
        const actionB = resolveNextAction(phase, state);
        const actionC = resolveNextAction(phase, state);

        expect(actionA).toEqual(actionB);
        expect(actionB).toEqual(actionC);
      });
    }
  });

  describe('HAPPY/BAD — allowed commands are subset of command policy', () => {
    const knownSlashCommands = new Set(ALL_COMMANDS.map((c) => `/${c}`));

    for (const phase of ALL_PHASES) {
      it(`${phase}: next-action commands are known and allowed in phase`, () => {
        const state = makeProgressedState(phase);
        const action = resolveNextAction(phase, state);

        for (const command of action.commands) {
          expect(knownSlashCommands.has(command)).toBe(true);
          const enumCommand = command.slice(1) as Command;
          expect(isCommandAllowed(phase, enumCommand)).toBe(true);
        }
      });
    }
  });

  describe('CORNER — policy modes only alter user-gate behavior dimensions', () => {
    for (const phase of ALL_PHASES) {
      it(`${phase}: mode variance is constrained`, () => {
        const state = makeProgressedState(phase);
        const results = POLICY_MODES.map((mode) => ({
          mode,
          evalResult: evaluate(state, resolvePolicy(mode)),
        }));

        if (USER_GATES.has(phase)) {
          const solo = results.find((r) => r.mode === 'solo')!.evalResult;
          const team = results.find((r) => r.mode === 'team')!.evalResult;
          const teamCi = results.find((r) => r.mode === 'team-ci')!.evalResult;
          const regulated = results.find((r) => r.mode === 'regulated')!.evalResult;

          expect(solo.kind).toBe('transition');
          expect(team.kind).toBe('waiting');
          expect(teamCi.kind).toBe('transition');
          expect(regulated.kind).toBe('waiting');
        } else {
          const [first, ...rest] = results;
          for (const r of rest) {
            expect(r.evalResult).toEqual(first.evalResult);
          }
        }
      });
    }
  });
});
