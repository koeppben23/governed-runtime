/**
 * @module architecture/__tests__/workflow-directive-ssot
 * @description Architectural guard: the canonical WorkflowDirective is the only
 *              place that decides "what next".
 *
 * Invariants (per reachable canonical state):
 * 1. Every directive command is an installed command whose machine workflow
 *    command is admissible in the state's position — presentation can never
 *    invent a command the machine rejects.
 * 2. The directive's allowed intents and its commands express exactly the same
 *    set of human decisions through the canonical intent↔command mapping.
 * 3. Shape invariants: system_work/terminal/blocked carry no commands and no
 *    intents; human gates carry at least one intent and only gate commands.
 * 4. Exhausted review loops flip the gate to the override intent; a
 *    reviewer-accepted or running loop never offers the override.
 * 5. Rejected/aborted/completed positions are terminal with empty commands.
 */

import { describe, expect, it } from 'vitest';
import { Phase, type SessionState } from '../../state/schema.js';
import { makeProgressedState, makeState } from '../../fixtures.js';
import {
  resolveWorkflowDirective,
  type WorkflowDirective,
  type WorkflowIntent,
} from '../../machine/workflow-directive.js';
import { Command, isCommandAllowed } from '../../machine/commands.js';
import { getInstalledCommand } from '../../integration/installed-commands.js';

/** Canonical intent → product command identity. */
const INTENT_COMMANDS: Readonly<Record<WorkflowIntent, string>> = {
  CAPTURE_TASK: '/task',
  CREATE_PLAN: '/plan',
  CREATE_ARCHITECTURE: '/architecture',
  RUN_PEER_REVIEW: '/review',
  APPROVE: '/approve',
  APPROVE_WITH_GOVERNANCE_OVERRIDE: '/override-approve',
  REQUEST_CHANGES: '/request-changes',
  REJECT: '/reject',
  IMPLEMENT: '/implement',
  EXPORT: '/export',
};

const PRODUCT_COMMANDS = new Set<string>(Object.values(INTENT_COMMANDS));

function directiveOf(state: SessionState): WorkflowDirective {
  return resolveWorkflowDirective(state);
}

function gateState(phase: 'PLAN_REVIEW' | 'ARCH_REVIEW' | 'EVIDENCE_REVIEW'): SessionState {
  return makeProgressedState(phase);
}

function exhaustedGateState(
  phase: 'PLAN_REVIEW' | 'ARCH_REVIEW' | 'EVIDENCE_REVIEW',
): SessionState {
  const base = makeProgressedState(phase);
  if (phase === 'PLAN_REVIEW') {
    return { ...base, plan: { ...base.plan!, reviewCompletion: 'review_exhausted' } };
  }
  if (phase === 'ARCH_REVIEW') {
    return {
      ...base,
      architecture: { ...base.architecture!, reviewCompletion: 'review_exhausted' },
    };
  }
  return {
    ...base,
    implementationRework: { rejectedDigest: base.implementation!.digest, exhausted: true },
  };
}

const ALL_STATES: ReadonlyArray<readonly [string, SessionState]> = [
  ...Phase.options.map((phase) => [`position ${phase}`, makeState(phase)] as const),
  ['exhausted PLAN_REVIEW', exhaustedGateState('PLAN_REVIEW')],
  ['exhausted ARCH_REVIEW', exhaustedGateState('ARCH_REVIEW')],
  ['exhausted EVIDENCE_REVIEW', exhaustedGateState('EVIDENCE_REVIEW')],
  [
    'blocked READY',
    {
      ...makeState('READY'),
      error: {
        code: 'TEST_BLOCKED',
        message: 'blocked',
        recoveryHint: 'recover',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    } satisfies SessionState,
  ],
];

describe('workflow directive SSOT', () => {
  it.each(ALL_STATES)('%s: every directive command is machine-admissible', (_label, state) => {
    for (const invocation of directiveOf(state).commands) {
      const installed = getInstalledCommand(invocation);
      expect(installed, `installed metadata for ${invocation}`).toBeDefined();
      const workflowCommand = installed!.target.workflowCommand;
      expect(workflowCommand, `workflow command for ${invocation}`).toBeDefined();
      expect(
        isCommandAllowed(state.phase, workflowCommand as Command),
        `${invocation} must be admissible at ${state.phase}`,
      ).toBe(true);
    }
  });

  it.each(ALL_STATES)('%s: intents and commands express the same decisions', (_label, state) => {
    const directive = directiveOf(state);
    const expectedCommands = directive.allowedIntents.map((intent) => INTENT_COMMANDS[intent]);
    expect([...directive.commands]).toEqual(expectedCommands);
    // No product command may appear without its intent, and no non-product
    // command may appear at all: the directive surface is exactly the human
    // workflow surface.
    for (const invocation of directive.commands) {
      expect(PRODUCT_COMMANDS.has(invocation), `${invocation} is a product command`).toBe(true);
    }
  });

  it.each(ALL_STATES)('%s: shape invariants hold', (_label, state) => {
    const directive = directiveOf(state);
    if (directive.kind === 'system_work' || directive.kind === 'terminal') {
      expect(directive.commands).toEqual([]);
      expect(directive.allowedIntents).toEqual([]);
    }
    if (directive.kind === 'blocked') {
      expect(directive.commands).toEqual([]);
      expect(directive.allowedIntents).toEqual([]);
      expect(directive.context?.reasonCode).toBeDefined();
    }
    if (directive.kind === 'human_gate') {
      expect(directive.allowedIntents.length).toBeGreaterThan(0);
      expect(directive.commands.length).toBeGreaterThan(0);
      // Exactly one approval flavour is legal at a gate.
      const approvals = directive.allowedIntents.filter(
        (intent) => intent === 'APPROVE' || intent === 'APPROVE_WITH_GOVERNANCE_OVERRIDE',
      );
      expect(approvals).toHaveLength(1);
    }
    if (directive.kind === 'user_action') {
      expect(directive.commands.length).toBeGreaterThan(0);
      expect(directive.allowedIntents.length).toBeGreaterThan(0);
    }
  });

  it('reviewer-accepted gates never offer the governance override', () => {
    for (const phase of ['PLAN_REVIEW', 'ARCH_REVIEW', 'EVIDENCE_REVIEW'] as const) {
      const directive = directiveOf(gateState(phase));
      expect(directive.code).not.toContain('OVERRIDE');
      expect(directive.allowedIntents).not.toContain('APPROVE_WITH_GOVERNANCE_OVERRIDE');
      expect(directive.allowedIntents).toContain('APPROVE');
    }
  });

  it('exhausted gates offer only the governance override, never plain approval', () => {
    const expected = {
      PLAN_REVIEW: 'PLAN_OVERRIDE_REQUIRED',
      ARCH_REVIEW: 'ARCHITECTURE_OVERRIDE_REQUIRED',
      EVIDENCE_REVIEW: 'IMPLEMENTATION_OVERRIDE_REQUIRED',
    } as const;
    for (const phase of ['PLAN_REVIEW', 'ARCH_REVIEW', 'EVIDENCE_REVIEW'] as const) {
      const directive = directiveOf(exhaustedGateState(phase));
      expect(directive.code).toBe(expected[phase]);
      expect(directive.allowedIntents).toEqual([
        'APPROVE_WITH_GOVERNANCE_OVERRIDE',
        'REQUEST_CHANGES',
        'REJECT',
      ]);
      expect(directive.commands).toEqual(['/override-approve', '/request-changes', '/reject']);
      expect(directive.allowedIntents).not.toContain('APPROVE');
    }
  });

  it('terminal positions never offer a command', () => {
    for (const phase of [
      'COMPLETE',
      'ARCH_COMPLETE',
      'PEER_REVIEW_COMPLETE',
      'REJECTED',
      'ABORTED',
    ] as const) {
      const directive = directiveOf(makeState(phase));
      expect(directive.kind, phase).toBe('terminal');
      expect(directive.commands, phase).toEqual([]);
      expect(directive.allowedIntents, phase).toEqual([]);
    }
  });
});
