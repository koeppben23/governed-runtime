import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  governanceActivationTarget,
  isGovernanceActivationTransition,
} from './governance-activation.js';
import {
  GovernanceActivationRevision,
  GovernanceActivationStatus,
  type GovernanceActivationAction,
} from '../state/governance-activation.js';

function record(patch: Partial<GovernanceActivationRevision> = {}): GovernanceActivationRevision {
  return GovernanceActivationRevision.parse({
    schemaVersion: 1,
    sessionId: 'root',
    rootSessionId: 'root',
    activationId: '00000000-0000-4000-8000-000000000001',
    generation: 1,
    revision: 1,
    status: 'activating',
    directory: '/project',
    worktreeRoot: '/project',
    policyDigest: 'a'.repeat(64),
    decisionId: 'start-decision',
    previousDigest: null,
    parentDispatch: null,
    ...patch,
  });
}
const statuses = GovernanceActivationStatus.options;

describe('explicit governance activation lifecycle', () => {
  it.each(statuses)(
    'only admits initial root ACTIVATING, not %s by inference from workflow state',
    (status) => {
      expect(isGovernanceActivationTransition(null, record({ status }))).toBe(
        status === 'activating',
      );
    },
  );

  for (const previous of statuses)
    for (const next of statuses) {
      it(`${previous} -> ${next} is admitted only by explicit lifecycle topology`, () => {
        const reactivation = previous === 'inactive';
        const prior = record({ status: previous });
        const after = record({
          revision: 2,
          status: next,
          previousDigest: 'b'.repeat(64),
          ...(reactivation ? { generation: 2, activationId: randomUUID() } : {}),
          decisionId: previous === 'active' ? 'end-decision' : prior.decisionId,
        });
        expect(isGovernanceActivationTransition(prior, after)).toBe(
          (previous === 'activating' && next === 'active') ||
            (previous === 'active' && next === 'ending') ||
            (previous === 'ending' && next === 'inactive') ||
            (previous === 'inactive' && next === 'activating'),
        );
      });
    }

  it.each([
    { sessionId: 'foreign' },
    { rootSessionId: 'foreign' },
    { activationId: '00000000-0000-4000-8000-000000000002' },
    { generation: 2 },
    { revision: 3 },
    { directory: '/other' },
    { worktreeRoot: '/other' },
    { policyDigest: 'b'.repeat(64) },
    { decisionId: 'replaced-decision' },
    { parentDispatch: { sessionId: 'parent', messageId: 'message', callId: 'call' } },
  ])('rejects active-transition scope/identity drift: %j', (patch) => {
    const previous = record();
    const next = record({
      status: 'active',
      revision: 2,
      previousDigest: 'b'.repeat(64),
      ...patch,
    });
    expect(isGovernanceActivationTransition(previous, next)).toBe(false);
  });

  it.each([
    { generation: 1 },
    { activationId: record().activationId },
    { rootSessionId: 'foreign' },
  ])('requires a genuinely new root activation generation after EndGovernance: %j', (patch) => {
    expect(
      isGovernanceActivationTransition(
        record({ status: 'inactive' }),
        record({
          revision: 2,
          generation: 2,
          activationId: randomUUID(),
          ...patch,
        }),
      ),
    ).toBe(false);
  });

  it('admits a delegated receipt only for a different child and preserves its root generation', () => {
    const first = record({
      sessionId: 'child',
      status: 'active',
      parentDispatch: { sessionId: 'root', messageId: 'message', callId: 'call' },
    });
    expect(isGovernanceActivationTransition(null, first)).toBe(true);
    expect(isGovernanceActivationTransition(null, { ...first, sessionId: 'root' })).toBe(false);
    expect(
      isGovernanceActivationTransition(null, {
        ...first,
        parentDispatch: { sessionId: 'child', messageId: 'message', callId: 'call' },
      }),
    ).toBe(false);
    const continuation = {
      ...first,
      revision: 2,
      previousDigest: 'b'.repeat(64),
      parentDispatch: { sessionId: 'root', messageId: 'message', callId: 'next' },
    };
    expect(isGovernanceActivationTransition(first, continuation)).toBe(true);
    // A provider-reused call ID in a new host assistant message is a new dispatch.
    expect(
      isGovernanceActivationTransition(first, {
        ...continuation,
        parentDispatch: { ...first.parentDispatch!, messageId: 'next-message' },
      }),
    ).toBe(true);
    expect(isGovernanceActivationTransition(first, { ...continuation, generation: 2 })).toBe(false);
    expect(
      isGovernanceActivationTransition(first, {
        ...continuation,
        parentDispatch: first.parentDispatch,
      }),
    ).toBe(false);
    expect(isGovernanceActivationTransition(first, { ...continuation, parentDispatch: null })).toBe(
      false,
    );
  });

  it.each([
    { revision: 2 },
    { previousDigest: 'b'.repeat(64) },
    { rootSessionId: 'foreign' },
    { generation: 2 },
  ])('rejects malformed first root enrollment: %j', (patch) => {
    expect(isGovernanceActivationTransition(null, record(patch))).toBe(false);
  });

  it.each([
    { status: 'activating' as const },
    { status: 'ending' as const },
    { sessionId: 'other' },
    { revision: 3 },
    { decisionId: 'new-decision' },
    { parentDispatch: { sessionId: 'foreign', messageId: 'message', callId: 'next' } },
    { activationId: '00000000-0000-4000-8000-000000000002' },
    { rootSessionId: 'foreign' },
    { directory: '/foreign' },
    { worktreeRoot: '/foreign' },
    { policyDigest: 'b'.repeat(64) },
  ])('rejects continuation drift independently for each identity field: %j', (patch) => {
    const first = record({
      sessionId: 'child',
      status: 'active',
      parentDispatch: { sessionId: 'root', messageId: 'message', callId: 'call' },
    });
    const next = {
      ...first,
      revision: 2,
      previousDigest: 'b'.repeat(64),
      parentDispatch: { sessionId: 'root', messageId: 'message', callId: 'next' },
      ...patch,
    };
    expect(isGovernanceActivationTransition(first, next)).toBe(false);
  });

  it('requires a new End decision but the same decision for completing End', () => {
    const active = record({ status: 'active' });
    expect(
      isGovernanceActivationTransition(active, { ...active, revision: 2, status: 'ending' }),
    ).toBe(false);
    const ending = { ...active, status: 'ending' as const, decisionId: 'end' };
    expect(
      isGovernanceActivationTransition(ending, {
        ...ending,
        revision: 2,
        status: 'inactive',
        decisionId: 'other',
      }),
    ).toBe(false);
  });

  it.each([
    ['start', 'activating'],
    ['activate', 'active'],
    ['begin_end', 'ending'],
    ['end', 'inactive'],
    ['enroll', 'active'],
  ] satisfies Array<[GovernanceActivationAction, GovernanceActivationRevision['status']]>)(
    'maps %s to its sole lifecycle target %s',
    (action, status) => {
      expect(governanceActivationTarget(action)).toBe(status);
    },
  );
});
