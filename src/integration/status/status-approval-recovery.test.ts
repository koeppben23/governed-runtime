/** Explicit and automatic-policy recovery surfaces project the enforced preflight, read-only. */
import { describe, expect, it } from 'vitest';
import { makeState, IMPL_EVIDENCE, FIXED_TIME } from '../../fixtures.js';
import { getPolicyPreset } from '../../config/policy.js';
import { createPolicySnapshot } from '../../config/policy-snapshot.js';
import { hashText } from '../../shared/hashing.js';
import { evaluateEvidenceApprovalPreflight } from '../../audit/proofgraph/evidence-approval-preflight.js';
import { resolveWorkflowDirective } from '../../machine/workflow-directive.js';
import { getInstalledCommand } from '../installed-commands.js';
import { isCommandAllowed } from '../../machine/commands.js';
import { buildStatusProjection } from './status.js';
import {
  buildBlockedProjection,
  buildReadinessProjection,
  projectEvidenceApprovalBlock,
} from './status-detail-projections.js';
import { buildHelpResult } from '../help/help-projection.js';

function evidenceState(mode: 'solo' | 'team') {
  const policy = getPolicyPreset(mode);
  const state = makeState('EVIDENCE_REVIEW', {
    policySnapshot: createPolicySnapshot(policy, FIXED_TIME, hashText),
    implementation: IMPL_EVIDENCE,
    implementationRiskAssessment: {
      computedMinimumTaskClass: 'HIGH-RISK',
      effectiveTaskClass: 'HIGH-RISK',
      declaredTaskClass: null,
      declarationKind: 'absent',
      ticketDigest: null,
      touchedSurfaces: ['state'],
      riskTriggers: ['state_integrity'],
      assessedFrom: 'implementation_changed_files',
      assessedFileCount: 1,
      implementationDigest: IMPL_EVIDENCE.digest,
    },
  });
  return { state, policy };
}

describe('approval recovery projection parity', () => {
  it.each(['solo', 'team'] as const)(
    '%s surfaces the actual preflight block without recommending approval',
    (mode) => {
      const { state, policy } = evidenceState(mode);
      const before = structuredClone(state);
      const preflight = evaluateEvidenceApprovalPreflight(state);
      expect(preflight.kind).toBe('blocked');
      if (preflight.kind !== 'blocked') throw new Error('expected a controlled preflight block');
      const projection = buildStatusProjection(state, policy);
      expect(projection.readiness).toBe('BLOCKED');
      expect(projection.blocker?.reasonCode).toBe(preflight.code);
      expect(projection.blocker?.reasonText).toContain('state_integrity');
      expect(projection.directive).toEqual(resolveWorkflowDirective(state));
      expect(projection.conclusion.kind).toBe('decision_required');
      if (projection.conclusion.kind !== 'decision_required')
        throw new Error('missing recovery decisions');
      expect(projection.conclusion.actions.map((action) => action.invocation)).toEqual([
        '/request-changes',
        '/reject',
      ]);
      for (const action of projection.conclusion.actions) {
        if (action.invocation === null) throw new Error('missing recovery invocation');
        const command = getInstalledCommand(action.invocation)?.target.workflowCommand;
        if (!command) throw new Error('unregistered recovery action');
        expect(isCommandAllowed(state.phase, command)).toBe(true);
      }
      const focused = buildBlockedProjection(state, policy);
      expect(focused.blocked).toBe(true);
      expect(focused.reasonCode).toBe(preflight.code);
      expect(focused.recoveryHint).toContain('different host-session id');
      expect(focused.nextResolvableCommand).toBeNull();
      expect(buildReadinessProjection(state, policy).blocked).toBe(true);
      const help = buildHelpResult(state, policy, { view: 'commands', scope: 'all' });
      for (const invocation of ['/approve', '/override-approve']) {
        expect(
          help.commands.find((command) => command.invocation === invocation)?.preflight,
        ).toMatchObject({
          status: 'blocked',
          reasonCode: preflight.code,
        });
      }
      expect(help.directive).toBeNull();
      for (const invocation of ['/request-changes', '/reject', '/abort']) {
        expect(
          help.commands.find((command) => command.invocation === invocation)?.preflight.status,
        ).toBe('available');
      }
      expect(
        help.commands.find((command) => command.invocation === '/plan')?.preflight,
      ).toMatchObject({
        status: 'blocked',
        reasonCode: 'WORKFLOW_COMMAND_NOT_ALLOWED',
      });
      expect(help.nextActionSummary).toContain('state_integrity');
      expect(state).toEqual(before);
    },
  );

  it('does not manufacture an approval block outside the evidence gate or when its preflight clears', () => {
    const { state, policy } = evidenceState('solo');
    expect(projectEvidenceApprovalBlock({ ...state, phase: 'IMPLEMENTATION' })).toBeNull();
    const clear = {
      ...state,
      implementationRiskAssessment: {
        ...state.implementationRiskAssessment!,
        riskTriggers: ['ceremony_only' as const],
      },
    };
    expect(projectEvidenceApprovalBlock(clear)).toBeNull();
    const projection = buildStatusProjection(clear, policy);
    expect(projection.conclusion.kind).toBe('next_action');
    if (projection.conclusion.kind === 'next_action')
      expect(projection.conclusion.action.invocation).toBe('/approve');
  });

  it('preserves machine-owned error and risk/discovery blocking precedence', () => {
    const { state } = evidenceState('solo');
    expect(
      projectEvidenceApprovalBlock({
        ...state,
        error: {
          code: 'TEST_ERROR',
          message: 'primary failure',
          recoveryHint: 'repair the original error',
          occurredAt: FIXED_TIME,
        },
      }),
    ).toBeNull();
    expect(
      projectEvidenceApprovalBlock({
        ...state,
        riskGate: {
          status: 'blocked',
          code: 'TEST_RISK',
          message: 'primary risk block',
          blockedAt: FIXED_TIME,
          lastDecisionId: 'decision',
        },
      }),
    ).toBeNull();
  });
});
