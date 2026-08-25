import * as crypto from 'node:crypto';
import {
  SessionState,
  type PendingAuditOperation,
  type Phase,
  type Event,
} from '../../state/schema.js';
import { hashText } from '../../shared/hashing.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { buildTransitionBody } from '../../audit/types.js';
import { computeCanonicalEventDigest } from '../../audit/canonical-digest.js';
import { finalizeImplementationEntry } from '../../adapters/implementation-base-authority.js';
import { PersistenceError } from '../../adapters/persistence.js';
import { refreshProofGraph } from '../proofgraph/refresh.js';

/**
 * Prepare the next state together with its durable audit operations.
 *
 * The state and its outbox commit are persisted atomically by the caller
 * (see writeStateWithArtifactsAndAuditOperations). Each operation binds the
 * pre-state, mutation, and post-state digests into the transition audit
 * event, so a reconciled event cryptographically attests the exact state
 * authority it documents.
 */
export async function prepareStateWithAuditOperations(
  previous: SessionState | null,
  nextState: SessionState,
  transitions: ReadonlyArray<{ from: string; to: string; event: string; at: string }> | undefined,
): Promise<SessionState> {
  const prepared = await prepareState(nextState);
  const exactTransitions = transitions ?? inferTransition(previous, prepared);
  return addAuditOperations(previous, prepared, exactTransitions);
}

async function prepareState(nextState: SessionState): Promise<SessionState> {
  const result = SessionState.safeParse(nextState);
  if (!result.success) {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      `Refusing to persist invalid state: ${result.error.message}`,
    );
  }
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

function stateDigest(state: SessionState): string {
  const { pendingAuditOperations: _operations, ...authority } = state;
  return hashText(canonicalJsonStringify(authority));
}

function addAuditOperations(
  previous: SessionState | null,
  next: SessionState,
  transitions: ReadonlyArray<{ from: string; to: string; event: string; at: string }>,
): SessionState {
  if (transitions.length === 0 || !next.policySnapshot.audit.emitTransitions) return next;
  const preStateDigest = previous ? stateDigest(previous) : hashText('absent');
  const postStateDigest = stateDigest(next);
  const mutationDigest = hashText(canonicalJsonStringify(transitions));
  const operations: PendingAuditOperation[] = transitions.map((transition, chainIndex) => {
    const operationId = crypto.randomUUID();
    const normalizedTransition: PendingAuditOperation['transition'] = {
      from: transition.from as Phase,
      to: transition.to as Phase,
      event: transition.event as Event,
      at: transition.at,
      chainIndex,
      autoAdvanced: chainIndex > 0,
    };
    const body = buildTransitionBody(
      next.id,
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
