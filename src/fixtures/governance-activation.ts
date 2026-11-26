/** Component fixture only: a semantic authorization port, never operator-UI proof. */
import { randomUUID } from 'node:crypto';
import {
  commitGovernanceActivation,
  confirmGovernanceActivationAudit,
  type GovernanceActivationCommit,
  type GovernanceActivationStore,
} from '../adapters/governance-activation.js';
import type { GovernanceActivationRevision } from '../state/governance-activation.js';

export function createActivationStoreFixture() {
  const values = new Map<string, unknown>();
  const store: GovernanceActivationStore = {
    async get(key) {
      return structuredClone(values.get(key));
    },
    async set(key, value) {
      values.set(key, structuredClone(value));
    },
    async scan({ prefix, after, limit }) {
      const entries = [...values.entries()]
        .filter(([key]) => key.startsWith(prefix) && (after === undefined || key > after))
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, value]) => ({ key, value: structuredClone(value) }));
      return {
        entries: entries.slice(0, limit),
        ...(entries.length > limit ? { next: entries[limit - 1]!.key } : {}),
      };
    },
  };
  let tail: Promise<unknown> = Promise.resolve();
  const withLock = async <T>(_sessionId: string, operation: () => Promise<T>): Promise<T> => {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
  return { values, store, withLock };
}

/** Fixture actor: an explicit, unverified component identity. */
export const FIXTURE_ACTIVATION_ACTOR = {
  actorId: 'fixture-operator',
  actorEmail: null,
  actorDisplayName: null,
  actorSource: 'env',
  actorAssurance: 'best_effort',
} as const;

export async function seedActiveGovernance(
  store: GovernanceActivationStore,
  input: { sessionId: string; directory: string; worktreeRoot?: string; policyDigest: string },
): Promise<void> {
  const decisionId = randomUUID();
  const request: GovernanceActivationCommit = {
    action: 'start',
    expectedRevision: 0,
    sessionId: input.sessionId,
    rootSessionId: input.sessionId,
    directory: input.directory,
    worktreeRoot: input.worktreeRoot ?? input.directory,
    policyDigest: input.policyDigest,
    activationId: randomUUID(),
    generation: 1,
    parentDispatch: null,
  };
  const writer = {
    store,
    withLock: async <T>(_id: string, run: () => Promise<T>) => run(),
    authorize: async () => ({
      kind: 'authorized' as const,
      decisionId,
      source: 'host_command' as const,
      actor: FIXTURE_ACTIVATION_ACTOR,
    }),
  };
  let active: GovernanceActivationRevision | undefined;
  for (const next of [request, { ...request, action: 'activate' as const, expectedRevision: 1 }]) {
    const result = await commitGovernanceActivation(writer, next);
    if (result.kind !== 'committed')
      throw new Error(`Cannot seed component activation fixture: ${result.reason}`);
    active = result.record;
  }
  if (active === undefined)
    throw new Error('Cannot seed component activation fixture: no ACTIVE revision.');
  // Component admission only. This marker authorizes the fixture scope for
  // runtime tests; it does not fabricate an activation audit event or claim
  // native/operator provenance.
  await confirmGovernanceActivationAudit(store, active);
}
