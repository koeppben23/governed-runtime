/** Live recovery verifier negatives; these tests do not claim a live host run. */
import { describe, expect, it } from 'vitest';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const runnerUrl = new URL(
  '../../../demos/risk-trigger-fixture/run-live-replan-recovery.mjs',
  import.meta.url,
);
const { assertRecoveryIdentities, oldControlApprovalCommand } = (await import(runnerUrl.href)) as {
  assertRecoveryIdentities(oldState: SessionState, newState: SessionState): void;
  oldControlApprovalCommand(
    directive: { commands: readonly string[] },
    allowOverride: boolean,
  ): string;
};
const oldState = makeState('ABORTED');
const newState = makeState('READY', {
  id: '11111111-1111-4111-8111-111111111111',
  flowguardSessionId: '11111111-1111-4111-8111-111111111111',
  binding: { ...oldState.binding, hostSessionId: 'new-host-session' },
  implementationBaseline: {
    ...oldState.implementationBaseline,
    dirtyFiles: [],
    controlPlaneMarker: 'trusted-baseline-marker',
  },
});

describe('live two-session recovery evidence contract', () => {
  it('never escalates ordinary approval to override implicitly, even for the old control', () => {
    expect(oldControlApprovalCommand({ commands: ['/approve'] }, false)).toBe('approve');
    expect(() => oldControlApprovalCommand({ commands: ['/override-approve'] }, false)).toThrow(
      'no implicit approval',
    );
    expect(oldControlApprovalCommand({ commands: ['/override-approve'] }, true)).toBe(
      'override-approve',
    );
    expect(() => oldControlApprovalCommand({ commands: [] }, true)).toThrow('no implicit approval');
  });
  it('accepts only the terminal-to-fresh identity handoff', () => {
    expect(() => assertRecoveryIdentities(oldState, newState)).not.toThrow();
  });
  it('rejects an un-aborted old session and a non-READY new session', () => {
    expect(() =>
      assertRecoveryIdentities({ ...oldState, phase: 'EVIDENCE_REVIEW' }, newState),
    ).toThrow('ABORTED');
    expect(() => assertRecoveryIdentities(oldState, { ...newState, phase: 'PLAN' })).toThrow(
      'READY',
    );
  });
  it('rejects reused host or FlowGuard identities independently', () => {
    expect(() =>
      assertRecoveryIdentities(oldState, { ...newState, binding: oldState.binding }),
    ).toThrow('host binding');
    expect(() =>
      assertRecoveryIdentities(oldState, {
        ...newState,
        flowguardSessionId: oldState.flowguardSessionId,
      }),
    ).toThrow('FlowGuard identity');
  });
  it('rejects preserved task changes imported before hydration', () => {
    expect(() =>
      assertRecoveryIdentities(oldState, {
        ...newState,
        implementationBaseline: {
          ...newState.implementationBaseline,
          dirtyFiles: [{ path: 'src/state/module-state.md', hash: 'hash-of-preserved-task-bytes' }],
        },
      }),
    ).toThrow('before the new baseline');
  });
  it('rejects unavailable baseline capture instead of treating it as a clean base', () => {
    for (const field of ['dirtyFiles', 'controlPlaneMarker'] as const) {
      expect(() =>
        assertRecoveryIdentities(oldState, {
          ...newState,
          implementationBaseline: { ...newState.implementationBaseline, [field]: null },
        }),
      ).toThrow('baseline is unavailable');
    }
  });
});
