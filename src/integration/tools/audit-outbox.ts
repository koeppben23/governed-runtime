import * as crypto from 'node:crypto';
import {
  SessionState,
  type PendingAuditOperation,
  type Phase,
  type Event,
} from '../../state/schema.js';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { buildStateWriteBody, buildTransitionBody } from '../../audit/types.js';
import { buildSemanticAuditBody } from '../../audit/semantic-event.js';
import { computeCanonicalEventDigest } from '../../audit/canonical-digest.js';
import {
  PersistenceError,
  readState,
  writeStateAlreadyLocked,
} from '../../adapters/persistence.js';
import { withSessionWriteLock } from '../../adapters/persistence-lock.js';
import { refreshProofGraph } from '../proofgraph/refresh.js';

export type SemanticAuditIntent = Extract<PendingAuditOperation, { kind: 'semantic' }>['semantic'];

/**
 * Prepare the next state together with its durable authority-write operations.
 *
 * The state and its outbox commit are persisted atomically by the caller
 * (see writeStateWithArtifactsAndAuditOperations). Each operation binds the
 * pre-state, mutation, and post-state digests into the audit event, so a
 * reconciled event cryptographically attests the exact state authority it
 * documents. Transition writes retain their transition-specific event; every
 * other authority-changing write receives one state_write operation.
 */
export async function prepareStateWithAuditOperations(
  previous: SessionState | null,
  nextState: SessionState,
  transitions: ReadonlyArray<{ from: string; to: string; event: string; at: string }> | undefined,
  semanticIntents: readonly SemanticAuditIntent[] = [],
): Promise<SessionState> {
  const prepared = await prepareState(nextState);
  return prepareAuditOperations(previous, prepared, transitions, semanticIntents);
}

/** Add durable audit operations without changing evidence artifacts or state. */
export function prepareAuditOperations(
  previous: SessionState | null,
  nextState: SessionState,
  transitions: ReadonlyArray<{ from: string; to: string; event: string; at: string }> | undefined,
  semanticIntents: readonly SemanticAuditIntent[] = [],
): SessionState {
  const result = SessionState.safeParse(nextState);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }
  const prepared = result.data;
  const exactTransitions = transitions ?? inferTransition(previous, prepared);
  return addAuditOperations(previous, prepared, exactTransitions, semanticIntents);
}

export async function writeStateWithAuditOperationsAlreadyLocked(
  sessDir: string,
  nextState: SessionState,
  semanticIntents: readonly SemanticAuditIntent[] = [],
): Promise<SessionState> {
  const previous = await readState(sessDir);
  const stateWithOperations = prepareAuditOperations(
    previous,
    nextState,
    undefined,
    semanticIntents,
  );
  await writeStateAlreadyLocked(sessDir, stateWithOperations);
  return stateWithOperations;
}

export async function writeStateWithAuditOperations(
  sessDir: string,
  nextState: SessionState,
  semanticIntents: readonly SemanticAuditIntent[] = [],
): Promise<SessionState> {
  return withSessionWriteLock(sessDir, () =>
    writeStateWithAuditOperationsAlreadyLocked(sessDir, nextState, semanticIntents),
  );
}

async function prepareState(nextState: SessionState): Promise<SessionState> {
  const result = SessionState.safeParse(nextState);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }
  const { finalizeImplementationEntry } =
    await import('../../adapters/implementation-base-authority.js');
  const finalized = await finalizeImplementationEntry(result.data);
  const refreshed = SessionState.safeParse({
    ...finalized,
    proofGraph: await refreshProofGraph(finalized, finalized.transition?.at ?? finalized.createdAt),
  });
  if (!refreshed.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid ProofGraph: ${refreshed.error.message}`,
    );
  }
  return refreshed.data;
}

function inferTransition(
  previous: SessionState | null,
  next: SessionState,
): ReadonlyArray<{ from: string; to: string; event: string; at: string }> {
  if (!next.transition) return [];
  const prior = previous?.transition;
  if (
    prior &&
    prior.from === next.transition.from &&
    prior.to === next.transition.to &&
    prior.event === next.transition.event &&
    prior.at === next.transition.at
  ) {
    return [];
  }
  return [next.transition];
}

/**
 * Canonical state-authority digest: the whole state except the outbox
 * itself. Single SSOT used at outbox commit time AND at reconciliation to
 * verify `operation.postStateDigest` against the actually persisted state.
 */
export function computeStateDigest(state: SessionState): string {
  return hashText(`state-digest.v2:${canonicalJsonStringify(authorityState(state))}`);
}

function authorityState(state: SessionState): Omit<SessionState, 'pendingAuditOperations'> {
  const { pendingAuditOperations: _operations, ...authority } = state;
  return authority;
}

function addAuditOperations(
  previous: SessionState | null,
  next: SessionState,
  transitions: ReadonlyArray<{ from: string; to: string; event: string; at: string }>,
  semanticIntents: readonly SemanticAuditIntent[],
): SessionState {
  const preStateDigest = previous
    ? computeStateDigest(previous)
    : hashText('state-digest.v2:absent');
  const postStateDigest = computeStateDigest(next);
  if (preStateDigest === postStateDigest) {
    // A repeated external failure can be auditworthy even when its idempotent
    // state projection is unchanged. Persist only the semantic occurrence;
    // never invent a state_write operation for this case.
    return addSemanticOperations(previous, next, preStateDigest, postStateDigest, semanticIntents);
  }
  // Session bootstrap has no prior authority to bind; hydrate owns its
  // lifecycle/transition evidence when it creates a governed session.
  if (previous === null && transitions.length === 0 && semanticIntents.length === 0) return next;
  let withOperations: SessionState;
  if (transitions.length === 0) {
    withOperations = addStateWriteOperation(previous, next, preStateDigest, postStateDigest);
  } else if (!next.policySnapshot.audit.emitTransitions) {
    // `emitTransitions` governs the transition projection only. It must never
    // disable the durable state↔audit binding itself.
    withOperations = addStateWriteOperation(previous, next, preStateDigest, postStateDigest);
  } else {
    withOperations = addTransitionOperations(
      previous,
      next,
      preStateDigest,
      postStateDigest,
      transitions,
    );
  }
  return addSemanticOperations(
    previous,
    withOperations,
    preStateDigest,
    postStateDigest,
    semanticIntents,
  );
}

function addTransitionOperations(
  previous: SessionState | null,
  next: SessionState,
  preStateDigest: string,
  postStateDigest: string,
  transitions: ReadonlyArray<{ from: string; to: string; event: string; at: string }>,
): SessionState {
  const mutationDigest = hashText(canonicalJsonStringify(transitions));
  const operations: PendingAuditOperation[] = transitions.map((transition, chainIndex) => {
    const operationId = crypto.randomUUID();
    const normalizedTransition: Extract<
      PendingAuditOperation,
      { kind: 'transition' }
    >['transition'] = {
      from: transition.from as Phase,
      to: transition.to as Phase,
      event: transition.event as Event,
      at: transition.at,
      chainIndex,
      autoAdvanced: chainIndex > 0,
    };
    const body = buildTransitionBody(
      next.flowguardSessionId,
      next.binding.hostSessionId,
      normalizedTransition.to,
      {
        operationId,
        preStateDigest,
        mutationDigest,
        postStateDigest,
        from: normalizedTransition.from,
        to: normalizedTransition.to,
        event: normalizedTransition.event,
        autoAdvanced: normalizedTransition.autoAdvanced,
        chainIndex: normalizedTransition.chainIndex,
      },
      transition.at,
      'genesis',
    );
    return {
      kind: 'transition',
      operationId,
      preStateDigest,
      mutationDigest,
      postStateDigest,
      auditEventDigest: computeCanonicalEventDigest(body),
      transition: normalizedTransition,
      status: 'state_committed',
    };
  });
  return { ...next, pendingAuditOperations: [...next.pendingAuditOperations, ...operations] };
}

function addSemanticOperations(
  previous: SessionState | null,
  next: SessionState,
  preStateDigest: string,
  postStateDigest: string,
  intents: readonly SemanticAuditIntent[],
): SessionState {
  const operations: PendingAuditOperation[] = intents.map((semantic) => {
    const operationId = crypto.randomUUID();
    const mutationDigest = hashText(
      canonicalJsonStringify({
        kind: 'semantic',
        before: previous ? authorityState(previous) : null,
        after: authorityState(next),
        semantic,
      }),
    );
    const body = buildSemanticAuditBody({
      flowguardSessionId: next.flowguardSessionId,
      hostSessionId: next.binding.hostSessionId,
      phase: semantic.phase,
      detail: semantic.detail,
      event: semantic.event,
      occurredAt: semantic.occurredAt,
      prevHash: 'genesis',
      operationId,
      preStateDigest,
      mutationDigest,
      postStateDigest,
    });
    return {
      kind: 'semantic',
      operationId,
      preStateDigest,
      mutationDigest,
      postStateDigest,
      auditEventDigest: computeCanonicalEventDigest(body),
      semantic,
      status: 'state_committed',
    };
  });
  return operations.length === 0
    ? next
    : { ...next, pendingAuditOperations: [...next.pendingAuditOperations, ...operations] };
}

function addStateWriteOperation(
  previous: SessionState | null,
  next: SessionState,
  preStateDigest: string,
  postStateDigest: string,
): SessionState {
  const operationId = crypto.randomUUID();
  const mutationDigest = hashText(
    canonicalJsonStringify({
      kind: 'state_write',
      before: previous ? authorityState(previous) : null,
      after: authorityState(next),
    }),
  );
  const at = new Date().toISOString();
  const body = buildStateWriteBody(
    next.flowguardSessionId,
    next.binding.hostSessionId,
    next.phase,
    { operationId, preStateDigest, mutationDigest, postStateDigest },
    at,
    'genesis',
  );
  const operation: PendingAuditOperation = {
    kind: 'state_write',
    operationId,
    preStateDigest,
    mutationDigest,
    postStateDigest,
    auditEventDigest: computeCanonicalEventDigest(body),
    stateWrite: { phase: next.phase, at },
    status: 'state_committed',
  };
  return { ...next, pendingAuditOperations: [...next.pendingAuditOperations, operation] };
}
