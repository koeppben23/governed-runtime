import { describe, expect, it } from 'vitest';
import { makeProgressedState, VALIDATION_PASSED } from '../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import type { SessionState } from '../state/schema.js';
import { makeAuditEvent, SESSION_ID, TS3 } from './audit-test-helpers.js';
import { validationExecutionCheck } from './validation-summary.js';

function stateWithAttempts(): SessionState {
  const state = makeProgressedState('COMPLETE');
  state.id = SESSION_ID;
  state.validationAttempts = [
    {
      attemptId: '00000000-0000-4000-8000-000000000001',
      scope: 'baseline',
      planDigest: state.plan!.current.digest,
      executionObservation: TEST_EXECUTION_OBSERVATION,
      result: VALIDATION_PASSED[0]!,
    },
    {
      attemptId: '00000000-0000-4000-8000-000000000002',
      scope: 'implementation',
      implementationId: state.implementation!.implementationId,
      implementationDigest: state.implementation!.digest,
      executionObservation: TEST_EXECUTION_OBSERVATION,
      result: VALIDATION_PASSED[0]!,
    },
  ];
  return state;
}

const baselinePassed = makeAuditEvent({
  event: 'transition:ALL_PASSED',
  phase: 'IMPLEMENTATION',
  occurredAt: TS3,
  detail: { kind: 'transition', from: 'VALIDATION', to: 'IMPLEMENTATION', event: 'ALL_PASSED' },
});
const implementationPassed = makeAuditEvent({
  event: 'transition:ALL_PASSED',
  phase: 'IMPL_REVIEW',
  occurredAt: TS3,
  detail: { kind: 'transition', from: 'IMPL_VALIDATION', to: 'IMPL_REVIEW', event: 'ALL_PASSED' },
});
const phases = [baselinePassed, implementationPassed];

describe('read-only validation execution summary', () => {
  it('counts current bound attempts, never labels outcomes automatic or double-counts host calls', () => {
    const state = stateWithAttempts();
    const before = structuredClone(state);
    const call = makeAuditEvent({
      event: 'tool_call:flowguard_run_check',
      phase: 'VALIDATION',
      detail: { kind: 'tool_call', tool: 'flowguard_run_check', success: true },
    });
    const result = validationExecutionCheck([...phases, call], state);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain(
      '2 bound validation attempt(s), 2 command result(s), 1 successful explicit call(s), 2 machine outcome(s)',
    );
    expect(result.detail).not.toContain('automatic');
    expect(result.detail).not.toContain('NOT_VERIFIED');
    expect(result.detail).not.toContain('no execution evidence');
    expect(state).toEqual(before);
  });

  it.each(['plan', 'implementation-digest', 'implementation-id'])(
    'does not use a superseded %s binding',
    (binding) => {
      const state = stateWithAttempts();
      if (binding === 'plan') state.plan!.current.digest = 'different';
      if (binding === 'implementation-digest')
        state.implementation = { ...state.implementation!, digest: 'different' };
      if (binding === 'implementation-id')
        state.implementation = { ...state.implementation!, implementationId: 'different' };
      expect(validationExecutionCheck(phases, state).passed).toBe(false);
    },
  );

  it('does not let baseline-only evidence satisfy post-implementation execution', () => {
    const state = stateWithAttempts();
    state.validationAttempts = state.validationAttempts.slice(0, 1);
    const result = validationExecutionCheck(phases, state);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('NOT_VERIFIED for IMPL_VALIDATION');
  });

  it('does not count blocked attempts as command execution', () => {
    const state = stateWithAttempts();
    state.validationAttempts = state.validationAttempts.map((a) => ({
      ...a,
      result: { ...a.result, passed: false, outcome: 'blocked' },
    }));
    const result = validationExecutionCheck(phases, state);
    expect(result.passed).toBe(false);
    expect(result.detail).toContain('2 bound validation attempt(s), 0 command result(s)');
  });

  it('does not infer execution from success, failure or error machine outcomes', () => {
    for (const [event, to] of [
      ['ALL_PASSED', 'IMPLEMENTATION'],
      ['CHECK_FAILED', 'PLAN'],
      ['CHECK_ERRORED', 'VALIDATION'],
    ] as const) {
      const transition = makeAuditEvent({
        event: `transition:${event}`,
        phase: to,
        detail: { kind: 'transition', from: 'VALIDATION', to, event },
      });
      expect(validationExecutionCheck([transition], null).passed).toBe(false);
    }
  });

  it('reports an explicit no-command policy exception without inventing commands', () => {
    const state = stateWithAttempts();
    state.validationAttempts = [];
    state.activeChecks = [];
    state.policySnapshot = {
      ...state.policySnapshot,
      validationEvidence: { enforcement: 'required', allowNoCommands: true },
    };
    const result = validationExecutionCheck(phases, state);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('0 command result(s)');
    expect(result.detail).toContain('no-command policy permits progression (not execution proof)');
    state.policySnapshot = {
      ...state.policySnapshot,
      validationEvidence: { enforcement: 'required', allowNoCommands: false },
    };
    expect(validationExecutionCheck(phases, state).passed).toBe(false);
  });

  it.each([
    { event: 'ALL_PASSED', to: 'COMPLETE' },
    { event: 'APPROVE', to: 'IMPLEMENTATION' },
  ])('rejects invalid validation transition %j', (detail) => {
    const event = makeAuditEvent({
      event: `transition:${detail.event}`,
      phase: detail.to,
      detail: { kind: 'transition', from: 'VALIDATION', ...detail },
    });
    expect(validationExecutionCheck([event], stateWithAttempts())).toMatchObject({
      passed: false,
      detail: expect.stringContaining('Invalid validation transition'),
    });
  });

  it('rejects state from another governed or host session', () => {
    const state = stateWithAttempts();
    expect(
      validationExecutionCheck([{ ...baselinePassed, flowguardSessionId: 'other' }], state).passed,
    ).toBe(false);
    expect(
      validationExecutionCheck([{ ...baselinePassed, hostSessionId: 'other' }], state).passed,
    ).toBe(false);
    expect(
      validationExecutionCheck(
        [baselinePassed, { ...implementationPassed, hostSessionId: 'other' }],
        state,
      ).passed,
    ).toBe(false);
  });

  it('reports no validation phase as not applicable, without misreading arbitrary events as transitions', () => {
    expect(
      validationExecutionCheck([makeAuditEvent({ phase: 'PLAN', detail: {} })], null),
    ).toMatchObject({ passed: true, detail: 'No validation phase reached (not applicable)' });
    const call = makeAuditEvent({
      event: 'tool_call:flowguard_run_check',
      phase: 'VALIDATION',
      detail: { from: 'VALIDATION', tool: 'flowguard_run_check', success: true },
    });
    expect(validationExecutionCheck([call], null).passed).toBe(true);
  });

  it('rejects mismatched transition name or recorded phase even with bound evidence', () => {
    const state = stateWithAttempts();
    for (const event of [
      { ...baselinePassed, event: 'transition:CHECK_FAILED' },
      { ...baselinePassed, phase: 'IMPL_REVIEW' },
    ]) {
      expect(validationExecutionCheck([event], state)).toMatchObject({
        passed: false,
        detail: expect.stringContaining('Invalid validation transition'),
      });
    }
  });

  it('cannot bind an implementation attempt without current implementation authority', () => {
    const state = stateWithAttempts();
    state.implementation = null;
    expect(validationExecutionCheck(phases, state).passed).toBe(false);
  });

  it.each(['ERROR', 'ABORT'] as const)('does not count %s as a validation outcome', (event) => {
    const state = stateWithAttempts();
    const to = event === 'ABORT' ? 'ABORTED' : 'VALIDATION';
    const transition = makeAuditEvent({
      event: `transition:${event}`,
      phase: to,
      detail: { from: 'VALIDATION', to, event },
    });
    const result = validationExecutionCheck([transition], state);
    expect(result.passed).toBe(true);
    expect(result.detail).toContain('0 machine outcome(s)');
  });

  it('rejects a forged inbound validation edge even when current bound attempts exist', () => {
    const forged = makeAuditEvent({
      event: 'transition:ALL_PASSED',
      phase: 'IMPL_VALIDATION',
      detail: {
        kind: 'transition',
        from: 'IMPLEMENTATION',
        to: 'IMPL_VALIDATION',
        event: 'ALL_PASSED',
      },
    });
    expect(validationExecutionCheck([forged], stateWithAttempts())).toMatchObject({
      passed: false,
      detail: expect.stringContaining('Invalid validation transition'),
    });
  });

  it('distinguishes successful explicit calls from failed or prefix-matching calls without state', () => {
    const call = makeAuditEvent({
      phase: 'VALIDATION',
      event: 'tool_call:flowguard_run_check',
      detail: { tool: 'flowguard_run_check', success: true },
    });
    expect(validationExecutionCheck([call], null).passed).toBe(true);
    expect(
      validationExecutionCheck([{ ...call, detail: { ...call.detail, success: false } }], null)
        .passed,
    ).toBe(false);
    expect(
      validationExecutionCheck([{ ...call, event: 'tool_call:flowguard_run_check_fake' }], null)
        .passed,
    ).toBe(false);
    expect(
      validationExecutionCheck([{ ...call, detail: { ...call.detail, tool: 'different' } }], null)
        .passed,
    ).toBe(false);
    expect(
      validationExecutionCheck([{ ...call, phase: 'IMPLEMENTATION' }, baselinePassed], null).passed,
    ).toBe(false);
    const state = stateWithAttempts();
    state.validationAttempts = [];
    expect(validationExecutionCheck([call], state).passed).toBe(false);
  });
});
