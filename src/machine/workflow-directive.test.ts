import { describe, expect, it } from 'vitest';
import { makeState, ARCHITECTURE_DECISION, PLAN_RECORD } from '../fixtures.js';
import { Phase, type SessionState } from '../state/schema.js';
import { resolveWorkflowDirective, type WorkflowDirective } from './workflow-directive.js';

describe('resolveWorkflowDirective', () => {
  it('resolves every persisted position exhaustively', () => {
    for (const phase of Phase.options) {
      const directive = resolveWorkflowDirective(makeState(phase));
      expect(directive.commands).toBeDefined();
      expect(directive.allowedIntents).toBeDefined();
      if (directive.kind === 'system_work' || directive.kind === 'terminal') {
        expect(directive.commands).toEqual([]);
        expect(directive.allowedIntents).toEqual([]);
      }
    }
  });

  it('maps ready to the only product flow choices', () => {
    expect(resolveWorkflowDirective(makeState('READY'))).toEqual({
      kind: 'user_action',
      code: 'CHOOSE_FLOW',
      allowedIntents: ['CAPTURE_TASK', 'CREATE_ARCHITECTURE', 'RUN_PEER_REVIEW'],
      commands: ['/task', '/architecture', '/review'],
    } satisfies WorkflowDirective);
  });

  it('projects persisted block authority before the position', () => {
    const state: SessionState = {
      ...makeState('READY'),
      error: {
        code: 'TEST_BLOCKED',
        message: 'blocked for test',
        recoveryHint: 'clear the test error',
        occurredAt: '2026-01-01T00:00:00.000Z',
      },
    };

    expect(resolveWorkflowDirective(state)).toEqual({
      kind: 'blocked',
      code: 'WORKFLOW_BLOCKED',
      allowedIntents: [],
      commands: [],
      context: { reasonCode: 'TEST_BLOCKED', recovery: 'clear the test error' },
    });
  });

  it('resolves the plan override gate from persisted review exhaustion only', () => {
    const exhausted = resolveWorkflowDirective(
      makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'review_exhausted' },
      }),
    );
    expect(exhausted).toEqual({
      kind: 'human_gate',
      code: 'PLAN_OVERRIDE_REQUIRED',
      allowedIntents: ['APPROVE_WITH_GOVERNANCE_OVERRIDE', 'REQUEST_CHANGES', 'REJECT'],
      commands: ['/override-approve', '/request-changes', '/reject'],
    } satisfies WorkflowDirective);

    const accepted = resolveWorkflowDirective(
      makeState('PLAN_REVIEW', {
        plan: { ...PLAN_RECORD, reviewCompletion: 'reviewer_accepted' },
      }),
    );
    expect(accepted).toEqual({
      kind: 'human_gate',
      code: 'PLAN_DECISION_REQUIRED',
      allowedIntents: ['APPROVE', 'REQUEST_CHANGES', 'REJECT'],
      commands: ['/approve', '/request-changes', '/reject'],
    } satisfies WorkflowDirective);
  });

  it('resolves the architecture override gate from persisted review exhaustion only', () => {
    const exhausted = resolveWorkflowDirective(
      makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'review_exhausted' },
      }),
    );
    expect(exhausted).toEqual({
      kind: 'human_gate',
      code: 'ARCHITECTURE_OVERRIDE_REQUIRED',
      allowedIntents: ['APPROVE_WITH_GOVERNANCE_OVERRIDE', 'REQUEST_CHANGES', 'REJECT'],
      commands: ['/override-approve', '/request-changes', '/reject'],
    } satisfies WorkflowDirective);

    const accepted = resolveWorkflowDirective(
      makeState('ARCH_REVIEW', {
        architecture: { ...ARCHITECTURE_DECISION, reviewCompletion: 'reviewer_accepted' },
      }),
    );
    expect(accepted).toEqual({
      kind: 'human_gate',
      code: 'ARCHITECTURE_DECISION_REQUIRED',
      allowedIntents: ['APPROVE', 'REQUEST_CHANGES', 'REJECT'],
      commands: ['/approve', '/request-changes', '/reject'],
    } satisfies WorkflowDirective);
  });

  it('resolves the implementation override gate from the exhausted rework marker only', () => {
    const exhausted = resolveWorkflowDirective(
      makeState('EVIDENCE_REVIEW', {
        implementationRework: { rejectedDigest: 'rejected-digest', exhausted: true },
      }),
    );
    expect(exhausted).toEqual({
      kind: 'human_gate',
      code: 'IMPLEMENTATION_OVERRIDE_REQUIRED',
      allowedIntents: ['APPROVE_WITH_GOVERNANCE_OVERRIDE', 'REQUEST_CHANGES', 'REJECT'],
      commands: ['/override-approve', '/request-changes', '/reject'],
    } satisfies WorkflowDirective);

    const inProgress = resolveWorkflowDirective(
      makeState('EVIDENCE_REVIEW', {
        implementationRework: { rejectedDigest: 'rejected-digest', exhausted: false },
      }),
    );
    expect(inProgress).toEqual({
      kind: 'human_gate',
      code: 'IMPLEMENTATION_DECISION_REQUIRED',
      allowedIntents: ['APPROVE', 'REQUEST_CHANGES', 'REJECT'],
      commands: ['/approve', '/request-changes', '/reject'],
    } satisfies WorkflowDirective);
  });
});
