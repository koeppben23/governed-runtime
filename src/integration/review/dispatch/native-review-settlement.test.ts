/** Unknown-outcome settlement and reopen, built from the real durable ledger transitions. */
import { describe, expect, it, vi } from 'vitest';
import { makeState } from '../../../fixtures.js';
import { SessionState } from '../../../state/schema.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import { encodeHostCallId } from '../../../state/host-identity.js';
import { resolveReviewContinuation } from '../../../state/review-continuation.js';
import {
  appendObligationWithAttempt,
  artifactReviewSubjectScope,
  createReviewObligation,
  freezeReviewMaterial,
} from '../obligations/assurance.js';
import { updateAttemptStatus } from '../obligations/attempt-lifecycle.js';
import {
  abandonAndBlockByHostCall,
  buildInterruptedDispatchRearm,
  persistAuthorizedReviewDispatch,
  type DispatchLedgerWriteDeps,
} from './durable-dispatch.js';
import {
  assertLaterUserTurn,
  proveChildSettled,
  reopenAuditIntents,
  reopenUnknownOutcome,
  unknownOutcomeTarget,
  type SettlementHost,
} from './native-review-settlement.js';

const NOW = '2026-11-03T12:00:00.000Z';
const PARENT = 'ses_parent';
const CHILD = 'ses_child';
const RELEASE_MESSAGE = 'msg_parent_release';
const HOST_CALL = encodeHostCallId(PARENT, RELEASE_MESSAGE, 'call_1');
const UNKNOWN = 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN';

async function blockedByCode(code: string = UNKNOWN) {
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
  const deps: DispatchLedgerWriteDeps = {
    updateReviewAssurance: vi.fn(async (_dir, update) => {
      stateRef.current = update(stateRef.current, NOW);
    }),
  };
  await persistAuthorizedReviewDispatch(deps, '/tmp/settlement', {
    attemptId: minted.attemptId,
    obligationId: obligation.obligationId,
    hostCallId: HOST_CALL,
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
      { childSessionId: CHILD },
    ),
  };
  await abandonAndBlockByHostCall(deps, '/tmp/settlement', HOST_CALL, code, {
    childSessionId: CHILD,
    obligationId: obligation.obligationId,
    attemptId: minted.attemptId,
  });
  return { state: stateRef.current, attemptId: minted.attemptId };
}

function host(histories: readonly (readonly unknown[])[]): SettlementHost & {
  interrupt: ReturnType<typeof vi.fn>;
} {
  let read = 0;
  return {
    interrupt: vi.fn(async () => ({ interrupted: false })),
    wait: vi.fn(async () => {}),
    context: vi.fn(async () => histories[Math.min(read++, histories.length - 1)]!),
  };
}

const settledChild = [
  { type: 'user', id: 'msg_serialize' },
  { type: 'idle', outcome: 'interrupted' },
];

describe('unknown reviewer outcome settlement', () => {
  it('finds exactly the stale lineage behind an unknown-outcome lock of the same family', async () => {
    const { state, attemptId } = await blockedByCode();
    expect(state.reviewAssurance?.capacityLock?.code).toBe(UNKNOWN);
    const target = unknownOutcomeTarget(state, 'plan');
    expect(target).toMatchObject({
      attempt: { attemptId, status: 'stale', childSessionId: CHILD },
      dispatch: { hostCallId: HOST_CALL, dispatchStatus: 'outcome_unknown' },
    });
    expect(unknownOutcomeTarget(state, 'architecture')).toBeNull();
  });

  it('leaves capacity closures of another kind to the capacity gate', async () => {
    const { state } = await blockedByCode('REVIEWER_STEP_BUDGET_EXHAUSTED');
    expect(state.reviewAssurance?.capacityLock?.code).toBe('REVIEWER_STEP_BUDGET_EXHAUSTED');
    expect(unknownOutcomeTarget(state, 'plan')).toBeNull();
  });

  it('requires a user message after the failed release in the parent history', async () => {
    const { state } = await blockedByCode();
    const { dispatch } = unknownOutcomeTarget(state, 'plan')!;
    const released = { type: 'assistant', id: RELEASE_MESSAGE };
    const code = { code: 'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND' };
    expect(() => assertLaterUserTurn([{ type: 'user', id: 'u1' }, released], dispatch)).toThrow(
      expect.objectContaining(code),
    );
    expect(() =>
      assertLaterUserTurn(
        [
          { type: 'user', id: 'u1' },
          { type: 'assistant', id: 'msg_x' },
        ],
        dispatch,
      ),
    ).toThrow(expect.objectContaining(code));
    expect(() =>
      assertLaterUserTurn(
        [{ type: 'user', id: 'u1' }, released, { type: 'user', id: 'u2' }],
        dispatch,
      ),
    ).not.toThrow();
  });

  it('proves settlement only by interrupt, wait and a stable idle boundary', async () => {
    const stable = host([settledChild, settledChild]);
    await expect(proveChildSettled(stable, CHILD)).resolves.toBeUndefined();
    expect(stable.interrupt).toHaveBeenCalledWith(CHILD);
    for (const histories of [
      [settledChild, [...settledChild, { type: 'user', id: 'msg_late' }]],
      [[{ type: 'user', id: 'msg_serialize' }], [{ type: 'user', id: 'msg_serialize' }]],
      [[{ type: 'idle', outcome: 'running' }], [{ type: 'idle', outcome: 'running' }]],
      [[], []],
    ])
      await expect(proveChildSettled(host(histories), CHILD)).rejects.toMatchObject({
        code: UNKNOWN,
      });
  });

  it('reopens atomically, keeps the history verbatim and lets the typed retry re-arm once', async () => {
    const { state, attemptId } = await blockedByCode();
    const target = unknownOutcomeTarget(state, 'plan')!;
    const reopened = reopenUnknownOutcome(state, target);
    const after = reopened.reviewAssurance!;
    expect(after.capacityLock).toBeNull();
    expect(after.obligations[0]).toMatchObject({ status: 'pending', blockedCode: null });
    expect(after.attempts).toEqual(state.reviewAssurance!.attempts);
    expect(after.dispatches).toEqual(state.reviewAssurance!.dispatches);
    expect(after.invocations).toEqual([]);
    expect(SessionState.safeParse(reopened).success).toBe(true);
    expect(reopenAuditIntents(target)(reopened, NOW)).toEqual([
      expect.objectContaining({
        event: 'review:obligation_reopened',
        detail: expect.objectContaining({ attemptId, childSessionId: CHILD }),
      }),
    ]);

    expect(resolveReviewContinuation(after, 'plan')).toMatchObject({
      kind: 'interrupted_dispatch',
      attemptId,
    });
    const spent = after.attempts.find((item) => item.attemptId === attemptId)!;
    const rearm = buildInterruptedDispatchRearm(after, spent, NOW);
    expect(rearm).toMatchObject({
      kind: 'ok',
      attempt: { origin: { kind: 'dispatch_rearm', predecessorAttemptId: attemptId } },
    });

    // A second reopen, or one after the lineage changed, fails closed.
    expect(() => reopenUnknownOutcome(reopened, target)).toThrow(UNKNOWN);
  });
});
