import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ReviewAttemptStatus } from '../../../state/evidence.js';
import { emptyReviewAssurance } from '../assurance.js';
import { attemptFor, NOW, pendingObligation } from '../../plugin-host-task-diagnostics-helpers.js';
import { createSessionState } from './enforcement.js';
import { registerExecutedTaskPrompt } from './execution-provenance.js';
import type { PendingReview } from './types.js';

const PROMPT = 'Review the host-issued artifact.';

function pendingFor(obligationId: string, attemptId: string): PendingReview {
  return {
    tool: 'flowguard_plan',
    requestedAt: NOW,
    obligationId,
    attemptId,
    subagentCalled: false,
    subagentRecord: null,
    contentMeta: null,
    canonicalPromptAnchor: null,
    expectedPromptDigest: createHash('sha256').update(PROMPT, 'utf8').digest('hex'),
    canonicalPrompt: PROMPT,
    capturedFindings: null,
    retryCount: 0,
    hostAttestationConstants: null,
    enforcementFailure: null,
    lastSchemaErrors: null,
    repairPromptRequired: false,
    expectedRepairPromptDigest: null,
  };
}

function setup(status: ReviewAttemptStatus = 'created', childSessionId?: string) {
  const enforcement = createSessionState();
  const obligation = pendingObligation();
  const attempt = attemptFor(obligation, childSessionId ?? '', { status });
  enforcement.pendingReviews.set(
    'flowguard_plan',
    pendingFor(obligation.obligationId, attempt.attemptId),
  );
  const assurance = emptyReviewAssurance();
  assurance.obligations.push(obligation);
  assurance.attempts.push(attempt);
  return { enforcement, assurance, obligation, attempt };
}

describe('registerExecutedTaskPrompt', () => {
  it('allows a created, unbound attempt', () => {
    const { enforcement, assurance, attempt } = setup();

    const result = registerExecutedTaskPrompt(enforcement, assurance, 'call-created', PROMPT, NOW);

    expect(result).toMatchObject({ kind: 'ready', prompt: { attemptId: attempt.attemptId } });
  });

  it('reports a second dispatch of the same attempt as in-flight, not blocked', () => {
    const { enforcement, assurance, obligation, attempt } = setup();

    const first = registerExecutedTaskPrompt(enforcement, assurance, 'call-a', PROMPT, NOW);
    const concurrent = registerExecutedTaskPrompt(enforcement, assurance, 'call-b', PROMPT, NOW);

    expect(first).toMatchObject({ kind: 'ready' });
    expect(concurrent).toMatchObject({
      kind: 'in_flight',
      obligationId: obligation.obligationId,
      attemptId: attempt.attemptId,
    });
    expect(enforcement.executedTaskPrompts).toHaveLength(1);
    expect(enforcement.executedTaskPrompts.has('call-a')).toBe(true);
  });

  it('rejects missing and duplicate host call IDs without overwriting a reservation', () => {
    const { enforcement, assurance } = setup();

    expect(registerExecutedTaskPrompt(enforcement, assurance, '', PROMPT, NOW)).toMatchObject({
      kind: 'blocked',
    });
    expect(registerExecutedTaskPrompt(enforcement, assurance, 'call-a', PROMPT, NOW)).toMatchObject(
      {
        kind: 'ready',
      },
    );
    expect(
      registerExecutedTaskPrompt(enforcement, assurance, 'call-a', 'other', NOW),
    ).toMatchObject({
      kind: 'blocked',
    });
    expect(enforcement.executedTaskPrompts.get('call-a')?.modelPromptDigest).toBe(
      createHash('sha256').update(PROMPT, 'utf8').digest('hex'),
    );
  });

  it.each<ReviewAttemptStatus>(['rejected', 'stale', 'expired'])(
    'blocks a %s attempt',
    (status) => {
      const { enforcement, assurance } = setup(status);

      const result = registerExecutedTaskPrompt(
        enforcement,
        assurance,
        `call-${status}`,
        PROMPT,
        NOW,
      );

      expect(result).toMatchObject({ kind: 'blocked' });
      expect(enforcement.executedTaskPrompts).toHaveLength(0);
    },
  );

  it('blocks a created attempt already bound to a child session', () => {
    const { enforcement, assurance } = setup('created', 'ses_existing_child');

    const result = registerExecutedTaskPrompt(enforcement, assurance, 'call-bound', PROMPT, NOW);

    expect(result).toMatchObject({ kind: 'blocked' });
    expect(enforcement.executedTaskPrompts).toHaveLength(0);
  });

  it.each<ReviewAttemptStatus>(['rejected', 'stale'])(
    'allows only the fresh attempt when an old %s attempt exists',
    (oldStatus) => {
      const { enforcement, assurance, obligation, attempt: oldAttempt } = setup(oldStatus);
      const freshAttempt = attemptFor(obligation, '', {
        attemptId: randomUUID(),
        ordinal: 1,
      });
      assurance.attempts.push(freshAttempt);

      enforcement.pendingReviews.set(
        'flowguard_plan',
        pendingFor(obligation.obligationId, freshAttempt.attemptId),
      );
      const fresh = registerExecutedTaskPrompt(enforcement, assurance, 'call-fresh', PROMPT, NOW);
      expect(fresh).toMatchObject({ kind: 'ready', prompt: { attemptId: freshAttempt.attemptId } });

      enforcement.pendingReviews.set(
        'flowguard_plan',
        pendingFor(obligation.obligationId, oldAttempt.attemptId),
      );
      const old = registerExecutedTaskPrompt(enforcement, assurance, 'call-old', PROMPT, NOW);
      expect(old).toMatchObject({ kind: 'blocked' });
      expect(enforcement.executedTaskPrompts.has('call-old')).toBe(false);
    },
  );
});
