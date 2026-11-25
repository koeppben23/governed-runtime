import { beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  createActivationStoreFixture,
  seedActiveGovernance,
} from '../fixtures/governance-activation.js';
import { resolveGovernanceActivation } from '../adapters/governance-activation.js';
import { makeState } from '../fixtures.js';
import {
  createDecisionOperation,
  readDecisionInvocation,
  runWithDecisionInvocation,
  verifyDecisionInvocation,
  type DecisionProbe,
  type DecisionInvocation,
} from './workflow-decision-invocation.js';
import type { WorkflowDecisionOperation } from '../state/governance-activation.js';

let probe: DecisionProbe;
let operation: WorkflowDecisionOperation;
beforeEach(async () => {
  const state = makeState('ARCH_REVIEW');
  probe = {
    context: { sessionID: 'root', worktree: '/repo' },
    state,
    verdict: 'approve',
    rationale: 'Reviewed',
  };
  const fixture = createActivationStoreFixture();
  await seedActiveGovernance(fixture.store, {
    sessionId: 'root',
    directory: '/repo',
    worktreeRoot: '/repo',
    policyDigest: state.policySnapshot.hash,
  });
  const activation = await resolveGovernanceActivation(fixture.store, 'root');
  if (activation.kind !== 'active') throw new Error('Expected active fixture');
  operation = createDecisionOperation(activation.record, state, probe, 'host_command');
});
describe('scoped decision invocation', () => {
  it('exists only inside the exact invocation and revalidates scope under the decision lock', async () => {
    const check = vi.fn(async () => {});
    expect(readDecisionInvocation(probe)).toBeUndefined();
    await runWithDecisionInvocation(operation, check, async () => {
      const invocation = readDecisionInvocation(probe)!;
      await verifyDecisionInvocation(invocation, probe);
      expect(check).toHaveBeenCalledOnce();
    });
    expect(readDecisionInvocation(probe)).toBeUndefined();
  });
  it.each(['session', 'worktree', 'policy', 'state', 'verdict', 'rationale', 'child', 'consumed'])(
    'rejects a mismatched %s operation without admitting scope',
    async (field) => {
      const changed = { ...operation };
      if (field === 'session') {
        changed.sessionId = 'other';
        changed.rootSessionId = 'other';
      }
      if (field === 'worktree') changed.worktreeRoot = '/other';
      if (field === 'policy') changed.policyDigest = '0'.repeat(64);
      if (field === 'state') changed.stateDigest = '0'.repeat(64);
      if (field === 'verdict') changed.verdict = 'approve_with_governance_override';
      if (field === 'rationale') changed.rationaleDigest = '0'.repeat(64);
      if (field === 'child') changed.rootSessionId = 'other-root';
      const check = vi.fn(async () => {});
      const invocation: DecisionInvocation = {
        operation: changed,
        committed: field === 'consumed',
        assertScopeCurrent: check,
      };
      await expect(verifyDecisionInvocation(invocation, probe)).rejects.toThrow(
        'HUMAN_DECISION_REQUIRED',
      );
      expect(check).not.toHaveBeenCalled();
    },
  );
  it('propagates unavailable activation/audit authority', async () => {
    await runWithDecisionInvocation(
      operation,
      async () => {
        throw new Error('scope unavailable');
      },
      async () => {
        await expect(
          verifyDecisionInvocation(readDecisionInvocation(probe)!, probe),
        ).rejects.toThrow('scope unavailable');
      },
    );
  });
  it('keeps concurrent and nested invocation identities isolated', async () => {
    const other = { ...operation, operationId: randomUUID() };
    await Promise.all(
      [operation, other].map((op) =>
        runWithDecisionInvocation(
          op,
          async () => {},
          async () => {
            await Promise.resolve();
            expect(readDecisionInvocation(probe)?.operation.operationId).toBe(op.operationId);
          },
        ),
      ),
    );
    expect(readDecisionInvocation(probe)).toBeUndefined();
  });
});
