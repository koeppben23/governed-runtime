/** Native EndGovernance and RecoverCapacity composition over real host state. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { FlowGuardAuditPlugin } from './plugin.js';
import { createV2Host } from './opencode-v2-test-helpers.js';
import { createTestWorkspace, type TestWorkspace } from './test-helpers.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { resolveGovernanceActivation } from '../adapters/governance-activation.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import * as audit from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import { makeState } from '../fixtures.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import { ensureReviewAssurance } from '../state/review-dispatch.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from './review/obligations/assurance.js';
import { updateAttemptStatus } from './review/obligations/attempt-lifecycle.js';
import {
  abandonAndBlockByHostCall,
  persistAuthorizedReviewDispatch,
  type DispatchLedgerWriteDeps,
} from './review/dispatch/durable-dispatch.js';
import { governanceEndBlocker } from './governance-end-preconditions.js';
import { updateCommandScope } from './plugin-command-scope.js';

const NOW = '2026-11-03T12:00:00.000Z';
let ws: TestWorkspace;
let host: ReturnType<typeof createV2Host>;
let cleanup: (() => void | Promise<void>) | undefined;
let sessionID: string;

beforeEach(async () => {
  ws = await createTestWorkspace();
  host = createV2Host(ws.tmpDir);
  sessionID = randomUUID();
  cleanup = (await FlowGuardAuditPlugin.setup(host.ctx)) || undefined;
  await host.command('start', sessionID);
});
afterEach(async () => {
  try {
    await cleanup?.();
  } finally {
    vi.restoreAllMocks();
    await ws.cleanup();
  }
});

async function workflow() {
  const bound = await resolveSessionAuthority({ root: ws.tmpDir, sessionId: sessionID });
  if (bound.status !== 'resolved') throw new Error('Expected workflow');
  return bound;
}

async function seedState(state: ReturnType<typeof makeState>) {
  const bound = await workflow();
  await writeStateWithArtifacts(bound.sessDir, {
    ...state,
    id: bound.state.id,
    flowguardSessionId: bound.state.flowguardSessionId,
    binding: bound.state.binding,
    policySnapshot: bound.state.policySnapshot,
  });
}

async function capacityLockedState(code = 'REVIEWER_STEP_BUDGET_EXHAUSTED') {
  const obligation = createReviewObligation({
    obligationType: 'plan',
    reviewCycle: 1,
    iteration: 0,
    planVersion: 1,
    now: NOW,
    subjectDigest: 'subject-digest-1',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'subject-digest-1'),
    reviewSubjectScope: artifactReviewSubjectScope('plan', '# Plan\nBody', 'subject-digest-1'),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
  });
  const minted = appendObligationWithAttempt(ensureReviewAssurance(undefined), obligation, NOW);
  const stateRef = { current: makeState('PLAN', { reviewAssurance: minted.assurance }) };
  const childSessionId = `child-${randomUUID()}`;
  const deps: DispatchLedgerWriteDeps = {
    updateReviewAssurance: vi.fn(async (_dir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
  };
  const hostCallId = `call-${randomUUID()}`;
  await persistAuthorizedReviewDispatch(deps, '/tmp/capacity', {
    attemptId: minted.attemptId,
    obligationId: obligation.obligationId,
    hostCallId,
    canonicalPromptDigest: 'b'.repeat(64),
    authorizedAt: NOW,
  });
  stateRef.current = {
    ...stateRef.current,
    reviewAssurance: updateAttemptStatus(
      ensureReviewAssurance(stateRef.current.reviewAssurance),
      minted.attemptId,
      'created',
      NOW,
      { childSessionId },
    ),
  };
  await abandonAndBlockByHostCall(deps, '/tmp/capacity', hostCallId, code, {
    childSessionId,
    obligationId: obligation.obligationId,
    attemptId: minted.attemptId,
  });
  return stateRef.current;
}

function lifecycleEvents(events: Awaited<ReturnType<typeof readAuditTrail>>) {
  return events.filter(
    (event) => event.event === 'governance:ended' || event.event === 'review:capacity_recovered',
  );
}

describe('native governance lifecycle commands', () => {
  it('ends ACTIVE governance only after terminal workflow closure and audits the exact decision once', async () => {
    await seedState(makeState('ABORTED'));
    const before = await workflow();
    await host.command('end-governance', sessionID);
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'inactive',
      record: { status: 'inactive', decisionSource: 'host_command' },
    });
    const events = await readAuditTrail(before.sessDir);
    expect(lifecycleEvents(events)).toMatchObject([
      {
        event: 'governance:ended',
        detail: { channel: 'host_command', generation: 1, rootSessionId: sessionID },
      },
    ]);
    expect(verifyChain(events).valid).toBe(true);
    await host.command('end-governance', sessionID);
    expect(lifecycleEvents(await readAuditTrail(before.sessDir))).toHaveLength(1);
  });

  it('refuses to end non-terminal or otherwise unsafe workflow state', async () => {
    await seedState(makeState('TICKET'));
    await expect(host.command('end-governance', sessionID)).rejects.toThrow(
      'GOVERNANCE_END_UNSAFE',
    );
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'active',
    });
  });

  it('keeps INACTIVE durable when the End audit append fails and reconciles it on retry', async () => {
    await seedState(makeState('ABORTED'));
    const append = audit.appendAuditEventAlreadyLocked;
    const fault = vi
      .spyOn(audit, 'appendAuditEventAlreadyLocked')
      .mockImplementation(async (directory, event) => {
        if (event.event === 'governance:ended') throw new Error('end audit append failure');
        return append(directory, event);
      });
    await expect(host.command('end-governance', sessionID)).rejects.toThrow(
      'GOVERNANCE_AUTHORITY_BLOCKED',
    );
    expect(await resolveGovernanceActivation(host.activation.store, sessionID)).toMatchObject({
      kind: 'inactive',
    });
    fault.mockRestore();
    await host.command('end-governance', sessionID);
    expect(lifecycleEvents(await readAuditTrail((await workflow()).sessDir))).toMatchObject([
      { event: 'governance:ended' },
    ]);
  });

  it('reports a capacity lock as an End blocker even after terminal workflow closure', async () => {
    const capacity = await capacityLockedState();
    expect(
      governanceEndBlocker(makeState('ABORTED', { reviewAssurance: capacity.reviewAssurance })),
    ).toMatchObject({ code: 'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND' });
    expect(governanceEndBlocker(makeState('READY'))).toBeNull();
  });

  it('releases only a proven step-budget/output-capacity lock and refuses an unknown outcome', async () => {
    const capacity = await capacityLockedState();
    await seedState(capacity);
    const before = await workflow();
    await host.command('recover-capacity', sessionID);
    const released = await workflow();
    expect(released.state.reviewAssurance?.capacityLock).toBeNull();
    expect(released.state.reviewAssurance?.obligations[0]).toMatchObject({
      status: 'blocked',
      blockedCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
    });
    expect(lifecycleEvents(await readAuditTrail(before.sessDir))).toMatchObject([
      {
        event: 'review:capacity_recovered',
        detail: {
          priorBlockedCode: 'REVIEWER_STEP_BUDGET_EXHAUSTED',
          operation: { source: 'host_command', obligationId: expect.any(String) },
        },
      },
    ]);
    await expect(host.command('recover-capacity', sessionID)).rejects.toThrow(
      'REVIEW_CAPACITY_NOT_LOCKED',
    );

    const unknown = await capacityLockedState('REVIEWER_EXECUTION_OUTCOME_UNKNOWN');
    await seedState(unknown);
    await expect(host.command('recover-capacity', sessionID)).rejects.toThrow(
      'REVIEW_CAPACITY_RECOVERY_UNSAFE',
    );
    expect((await workflow()).state.reviewAssurance?.capacityLock?.code).toBe(
      'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
    );
  });
  it('installs the explicit check scope from the installed prompt marker only', () => {
    const sessionId = 'check-session';
    const scopes = new Map<string, 'check'>();
    const rework = new Map([[sessionId, { marker: true }]]);
    const runtime = {
      activeCommandScopes: scopes,
      checkReworkContinuations: rework,
    } as never;
    updateCommandScope(runtime, sessionId, 'ordinary prompt');
    expect(scopes.has(sessionId)).toBe(false);
    updateCommandScope(
      runtime,
      sessionId,
      'Run automated verification checks for the current implementation.',
    );
    expect(scopes.get(sessionId)).toBe('check');
    expect(rework.has(sessionId)).toBe(false);
    updateCommandScope(runtime, sessionId, 'next explicit command');
    expect(scopes.has(sessionId)).toBe(false);
  });
});
