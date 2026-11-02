/**
 * @module integration/review/dispatch/host-neutral-contract.test
 * @description A minimal independent host adapter proves the review-mode
 * contract is consumable without importing the OpenCode adapter, SDK types or
 * plugin composition. This is a test fixture, not a supported host.
 */
import { describe, expect, it } from 'vitest';
import type { HostAdapter, HostSession } from '../../../adapters/host-adapter.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../../shared/flowguard-identifiers.js';
import {
  artifactReviewSubjectScope,
  createObligationAndAttempt,
} from '../obligations/assurance.js';
import type { ReviewDispatchAuthority } from './dispatch-authority.js';
import {
  buildChildSessionReviewInstruction,
  type ChildSessionReviewInstructionInput,
} from './child-session-instruction.js';
import { resolveReviewOrchestrationMode } from './orchestration-mode.js';

/** Test-only second host: no OpenCode SDK, plugin, tool name or transport import. */
class MinimalHostAdapter implements HostAdapter {
  private readonly sessions = new Map<string, HostSession>();
  private readonly histories = new Map<string, readonly unknown[]>();
  readonly logs: string[] = [];

  addSession(session: HostSession, history: readonly unknown[] = []): void {
    this.sessions.set(session.sessionId, session);
    this.histories.set(session.sessionId, history);
  }

  async initialize(): Promise<void> {}

  async shutdown(): Promise<void> {}

  async getSession(sessionId: string): Promise<HostSession> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new TypeError(`Unknown host session: ${sessionId}`);
    return session;
  }

  async readHistory(sessionId: string): Promise<unknown> {
    return this.histories.get(sessionId) ?? [];
  }

  log(_level: 'debug' | 'info' | 'warn' | 'error', message: string): void {
    this.logs.push(message);
  }
}

function authority(): ReviewDispatchAuthority {
  const minted = createObligationAndAttempt(
    undefined,
    {
      policySnapshot: {
        challengePolicy: {
          version: 'challenge-policy.v1',
          counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
        },
        maxReviewerAttempts: 1,
      },
      obligationType: 'plan',
      reviewCycle: 1,
      repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      iteration: 0,
      planVersion: 1,
      now: '2026-01-01T00:00:00.000Z',
      subjectDigest: 'second-host-subject',
      reviewMaterial: {
        content: 'frozen review material',
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'second-host-subject',
      },
      reviewSubjectScope: artifactReviewSubjectScope(
        'plan',
        '# Overview\nSecond host review',
        'second-host-subject',
      ),
    },
    '2026-01-01T00:00:00.000Z',
  );
  return { obligation: minted.obligation, attempt: minted.attempt };
}

function secondHostDispatch(instruction: ChildSessionReviewInstructionInput) {
  const built = buildChildSessionReviewInstruction(instruction);
  if (built.mode !== 'host_structured') return { kind: 'external' as const, built };
  if (!built.subagent) throw new TypeError('host_structured review requires a native subagent');
  return {
    kind: 'dispatch' as const,
    built,
    reviewer: {
      agent: built.subagent.agent,
      background: built.subagent.background,
      description: built.subagent.description,
    },
  };
}

describe('host-neutral review orchestration contract', () => {
  it('is consumed by a second host adapter without OpenCode-specific imports', async () => {
    const adapter = new MinimalHostAdapter();
    adapter.addSession(
      {
        sessionId: 'second-host-parent',
        directory: '/second-host/worktree',
        agent: 'build',
      },
      [{ type: 'assistant', id: 'second-host-message' }],
    );
    await adapter.initialize();
    expect(await adapter.getSession('second-host-parent')).toMatchObject({
      sessionId: 'second-host-parent',
      directory: '/second-host/worktree',
    });
    expect(await adapter.readHistory('second-host-parent')).toHaveLength(1);

    const dispatch = secondHostDispatch({
      mode: resolveReviewOrchestrationMode({ nativeStructuredReview: true }),
      authority: authority(),
      iteration: 0,
      planVersion: 1,
    });
    expect(dispatch.kind).toBe('dispatch');
    if (dispatch.kind !== 'dispatch') return;
    expect(dispatch.built.transport).toBe('native_subagent');
    expect(dispatch.reviewer.agent).toBe(REVIEWER_SUBAGENT_TYPE);
    expect(dispatch.built).not.toHaveProperty('platform');
  });

  it('keeps the external-instruction mode free of a native subagent dispatch', () => {
    const dispatch = secondHostDispatch({
      mode: resolveReviewOrchestrationMode({
        nativeStructuredReview: false,
        externalInstructionTransport: true,
      }),
      authority: authority(),
      iteration: 0,
      planVersion: 1,
    });
    expect(dispatch.kind).toBe('external');
    expect(dispatch.built).not.toHaveProperty('transport');
    expect(dispatch.built.mode).toBe('external_instruction_pending');
  });

  it('preserves identical governance authority across contrasting host capabilities', () => {
    const reviewAuthority = authority();
    const structured = buildChildSessionReviewInstruction({
      mode: resolveReviewOrchestrationMode({ nativeStructuredReview: true }),
      authority: reviewAuthority,
      iteration: 0,
      planVersion: 1,
    });
    const external = buildChildSessionReviewInstruction({
      mode: resolveReviewOrchestrationMode({
        nativeStructuredReview: false,
        externalInstructionTransport: true,
      }),
      authority: reviewAuthority,
      iteration: 0,
      planVersion: 1,
    });
    const governance = (instruction: typeof structured) => ({
      obligationId: instruction.obligationId,
      reviewAttemptId: instruction.reviewAttemptId,
      authority: instruction.authority,
      requiredReviewAttestation: instruction.requiredReviewAttestation,
      reviewDispatch: instruction.reviewDispatch,
    });
    expect(governance(structured)).toEqual(governance(external));
    expect(structured.transport).toBe('native_subagent');
    expect(external).not.toHaveProperty('transport');
  });
});
