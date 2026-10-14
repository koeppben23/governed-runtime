/** Live recovery verifier negatives; these tests do not claim a live host run. */
import { describe, expect, it } from 'vitest';
import { makeState } from '../../fixtures.js';
import type { SessionState } from '../../state/schema.js';

const runnerUrl = new URL(
  '../../../demos/risk-trigger-fixture/run-live-replan-recovery.mjs',
  import.meta.url,
);
const {
  assertFrozenRiskTriggerPaths,
  assertRecoveryIdentities,
  exhaustedOverrideSubjectBindable,
  oldControlApprovalCommand,
} = (await import(runnerUrl.href)) as {
  assertRecoveryIdentities(oldState: SessionState, newState: SessionState): void;
  oldControlApprovalCommand(
    directive: { commands: readonly string[] },
    allowOverride: boolean,
  ): string;
  exhaustedOverrideSubjectBindable(state: unknown): boolean;
  assertFrozenRiskTriggerPaths(state: unknown, expected: unknown, label: string): void;
};
const { fixtureRepoConfigRiskTriggerPaths } = (await import(
  new URL('../../../demos/risk-trigger-fixture/run-live-risk-trigger-controls.mjs', import.meta.url)
    .href
)) as { fixtureRepoConfigRiskTriggerPaths(fixtureDir?: string): unknown };
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
  it('proves the fixture risk mapping is frozen into both recovery sessions', () => {
    const expected = fixtureRepoConfigRiskTriggerPaths();
    expect(expected).toEqual([
      { trigger: 'state_integrity', pattern: 'src/main/java/fixture/state/**' },
    ]);
    const matching = { policySnapshot: { riskTriggerPaths: expected } };
    expect(() => assertFrozenRiskTriggerPaths(matching, expected, 'old')).not.toThrow();
    expect(() => assertFrozenRiskTriggerPaths(matching, expected, 'new')).not.toThrow();
  });

  it('refuses a recovery session whose frozen mapping is absent or different', () => {
    const expected = [{ trigger: 'state_integrity', pattern: 'src/main/java/fixture/state/**' }];
    expect(() =>
      assertFrozenRiskTriggerPaths({ policySnapshot: { riskTriggerPaths: [] } }, expected, 'new'),
    ).toThrow('riskTriggerPaths');
    expect(() => assertFrozenRiskTriggerPaths({ policySnapshot: {} }, expected, 'new')).toThrow(
      'riskTriggerPaths',
    );
    expect(() =>
      assertFrozenRiskTriggerPaths(
        { policySnapshot: { riskTriggerPaths: [{ trigger: 'audit_authority', pattern: 'x' }] } },
        expected,
        'new',
      ),
    ).toThrow('riskTriggerPaths');
  });

  it('binds an exhausted override only to the last reviewed plan subject', () => {
    const reviewed = {
      plan: { current: { digest: 'plan-subject-3', planVersion: 3 } },
      reviewAssurance: {
        obligations: [
          { obligationType: 'plan', status: 'consumed', subjectDigest: 'plan-subject-1' },
          { obligationType: 'plan', status: 'consumed', subjectDigest: 'plan-subject-3' },
        ],
      },
    };
    expect(exhaustedOverrideSubjectBindable(reviewed)).toBe(true);
    expect(
      exhaustedOverrideSubjectBindable({
        ...reviewed,
        plan: { current: { digest: 'plan-subject-4', planVersion: 4 } },
      }),
    ).toBe(false);
    expect(
      exhaustedOverrideSubjectBindable({
        plan: reviewed.plan,
        reviewAssurance: { obligations: [] },
      }),
    ).toBe(false);
    expect(exhaustedOverrideSubjectBindable({ plan: reviewed.plan })).toBe(false);
    expect(
      exhaustedOverrideSubjectBindable({
        plan: { current: { digest: 'plan-subject-3' } },
        reviewAssurance: {
          obligations: [
            { obligationType: 'plan', status: 'pending', subjectDigest: 'plan-subject-3' },
          ],
        },
      }),
    ).toBe(false);
  });

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
          dirtyFiles: [
            {
              path: 'src/main/java/fixture/state/ModuleStateStore.java',
              hash: 'hash-of-preserved-task-bytes',
            },
          ],
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
