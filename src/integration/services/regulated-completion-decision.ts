/**
 * @module integration/services/regulated-completion-decision
 * @description Terminal decision authority, ordering, and outbox correlation
 *              recovery for the regulated completion chain.
 *
 * The decision receipt must precede the export transition in the audit trail.
 * Recovery commits the receipt before any reconciliation drains the export
 * and serializes the durability decision with concurrent audit appenders via
 * the audit write lock; once the export transition is durable, no late
 * receipt is fabricated.
 *
 * A crash between the successful append and the state commit leaves the
 * receipt durable while its outbox operation is missing. Recovery reconstructs
 * the exact operation from the durable event — accepted only when the rebuilt
 * canonical event digest reproduces the persisted `semanticEventDigest`, so
 * provenance is never invented from an unverifiable event.
 *
 * @version v1
 */

import { readState, PersistenceError } from '../../adapters/persistence.js';
import {
  appendAuditEventAlreadyLocked,
  readAuditTrail,
  withAuditTrailLock,
} from '../../adapters/persistence-audit.js';
import { computeCanonicalEventDigest } from '../../audit/canonical-digest.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { buildSemanticAuditBody } from '../../audit/semantic-event.js';
import { resolveTimestampEvidence } from '../../audit/timestamp-resolution.js';
import { finalizeWithTimestampEvidence } from '../../audit/types.js';
import type { TimestampAssurancePolicy } from '../../config/policy-types.js';
import { resolvePolicyFromSnapshot } from '../../config/policy.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import type { AuditEvent } from '../../state/evidence.js';
import { DecisionIdentity } from '../../state/evidence-identity.js';
import { Phase, type PendingAuditOperation, type SessionState } from '../../state/schema.js';
import { prepareAuditOperations } from '../audit-outbox.js';
import type { AuditDeps } from '../plugin-audit.js';
import { TOOL_FLOWGUARD_DECISION } from '../tool-names.js';
import {
  writeStateWithArtifactsAndAuditOperations,
  withSessionWriteTransaction,
} from '../tools/helpers.js';
import { buildDecisionAuditIntent } from './decision-audit-intent.js';

/**
 * The exact P26 regulated ticket-completion contract. Recovery, resume, and
 * the completion chain itself must never touch other terminal flows: a
 * regulated ARCH_COMPLETE or REVIEW_COMPLETE session is not a ticket-flow
 * completion and its state must remain byte-semantically untouched.
 */
export function isRegulatedTicketCompletion(state: SessionState): boolean {
  return (
    state.phase === 'COMPLETE' &&
    state.transition?.to === 'COMPLETE' &&
    state.transition?.from === 'EXPORT_READY' &&
    state.transition?.event === 'EXPORT_MATERIALIZED' &&
    state.policySnapshot.mode === 'regulated' &&
    !state.error
  );
}

/**
 * The approval transition that authorized the export. The terminal state only
 * retains the export transition, so the approval authority is recovered from
 * the durable transition outbox (reconciled or not — operations are retained
 * as correlation evidence).
 */
function findApprovalTransition(
  state: SessionState,
): NonNullable<SessionState['transition']> | null {
  for (const operation of state.pendingAuditOperations) {
    if (
      operation.kind === 'transition' &&
      operation.transition.from === 'EVIDENCE_REVIEW' &&
      operation.transition.to === 'EXPORT_READY' &&
      operation.transition.event === 'APPROVE'
    ) {
      return {
        from: operation.transition.from,
        to: operation.transition.to,
        event: operation.transition.event,
        at: operation.transition.at,
      };
    }
  }
  const transition = state.transition;
  if (
    transition?.from === 'EVIDENCE_REVIEW' &&
    transition.to === 'EXPORT_READY' &&
    transition.event === 'APPROVE'
  ) {
    return transition;
  }
  return null;
}

function isSameDecisionIdentity(detail: Record<string, unknown>, state: SessionState): boolean {
  const decision = state.reviewDecision;
  if (!decision) return false;
  const parsed = DecisionIdentity.safeParse(detail.decisionIdentity);
  return (
    parsed.success &&
    canonicalJsonStringify(parsed.data) === canonicalJsonStringify(decision.decisionIdentity)
  );
}

function isTerminalDecisionDetail(detail: Record<string, unknown>, state: SessionState): boolean {
  const transition = findApprovalTransition(state);
  const decision = state.reviewDecision;
  if (!transition || !decision) return false;
  return (
    detail.kind === 'decision' &&
    detail.fromPhase === transition.from &&
    detail.toPhase === transition.to &&
    detail.transitionEvent === transition.event &&
    detail.verdict === decision.verdict &&
    detail.rationale === decision.rationale &&
    isSameDecisionIdentity(detail, state) &&
    detail.decidedAt === decision.decidedAt
  );
}

function hasPendingTerminalDecision(state: SessionState): boolean {
  return state.pendingAuditOperations.some(
    (operation) =>
      operation.kind === 'semantic' &&
      operation.status !== 'reconciled' &&
      isTerminalDecisionDetail(operation.semantic.detail, state),
  );
}

type DecisionOperation = Extract<PendingAuditOperation, { kind: 'semantic' }>;

type DurableDecisionReceipt =
  | { readonly kind: 'no-receipt' }
  | { readonly kind: 'correlated' }
  | { readonly kind: 'repaired'; readonly state: SessionState };

/**
 * Resolve the durable terminal decision receipt against the state outbox.
 *
 * The receipt event is durable authority even when its outbox operation is
 * not: a crash between the append and the state commit leaves the event
 * durable without provenance. Recovery reconstructs the exact operation from
 * the event — accepted only when the rebuilt canonical event digest
 * reproduces the persisted `semanticEventDigest` and the operation identity
 * matches the event id. An unverifiable receipt fails closed instead of
 * fabricating correlation evidence.
 */
async function resolveDurableDecisionReceipt(
  sessDir: string,
  state: SessionState,
): Promise<DurableDecisionReceipt> {
  const receipts = (await readAuditTrail(sessDir)).filter((event) =>
    isTerminalDecisionDetail(event.detail, state),
  );
  const [receipt] = receipts;
  if (receipt === undefined) return { kind: 'no-receipt' };
  if (receipts.length > 1) {
    throw new PersistenceError(
      'WRITE_FAILED',
      'Multiple durable terminal decision receipts exist for one decision authority; refusing to continue',
    );
  }
  if (state.pendingAuditOperations.some((operation) => operation.operationId === receipt.id)) {
    return { kind: 'correlated' };
  }
  const operation = reconstructDecisionOperation(state, receipt);
  if (operation === null) {
    throw new PersistenceError(
      'WRITE_FAILED',
      'Durable terminal decision receipt cannot be verified against its outbox correlation; refusing to fabricate provenance',
    );
  }
  return { kind: 'repaired', state: insertDecisionOperation(state, operation) };
}

/**
 * Rebuild the outbox operation a durable receipt event was appended from.
 * The semantic detail, digests, and identity all travel in the event; the
 * rebuilt body must reproduce the event digest exactly, so this is
 * verification, not synthesis.
 */
function reconstructDecisionOperation(
  state: SessionState,
  event: AuditEvent,
): DecisionOperation | null {
  const detail = event.detail;
  const operationId = detail.operationId;
  const preStateDigest = detail.preStateDigest;
  const mutationDigest = detail.mutationDigest;
  const postStateDigest = detail.postStateDigest;
  if (
    typeof operationId !== 'string' ||
    operationId !== event.id ||
    typeof preStateDigest !== 'string' ||
    typeof mutationDigest !== 'string' ||
    typeof postStateDigest !== 'string'
  ) {
    return null;
  }
  const phase = Phase.safeParse(event.phase);
  if (!phase.success) return null;
  const semanticDetail = { ...detail };
  delete semanticDetail.operationId;
  delete semanticDetail.preStateDigest;
  delete semanticDetail.mutationDigest;
  delete semanticDetail.postStateDigest;
  const body = buildSemanticAuditBody({
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: state.binding.hostSessionId,
    phase: phase.data,
    detail: semanticDetail,
    event: event.event,
    occurredAt: event.occurredAt,
    prevHash: event.prevHash,
    operationId,
    preStateDigest,
    mutationDigest,
    postStateDigest,
    actor: event.actor,
    ...(event.actorInfo !== undefined ? { actorInfo: event.actorInfo } : {}),
  });
  const auditEventDigest = computeCanonicalEventDigest(body);
  if (auditEventDigest !== event.semanticEventDigest) return null;
  return {
    kind: 'semantic',
    operationId,
    preStateDigest,
    mutationDigest,
    postStateDigest,
    auditEventDigest,
    semantic: {
      phase: phase.data,
      event: event.event,
      occurredAt: event.occurredAt,
      actor: event.actor,
      ...(event.actorInfo !== undefined ? { actorInfo: event.actorInfo } : {}),
      detail: semanticDetail,
    },
    status: 'reconciled',
  };
}

function findExportOperationIndex(state: SessionState): number {
  const transition = state.transition;
  if (!transition) return -1;
  return state.pendingAuditOperations.findIndex(
    (operation) =>
      operation.kind === 'transition' &&
      operation.transition.from === transition.from &&
      operation.transition.to === transition.to &&
      operation.transition.event === transition.event,
  );
}

/**
 * Insert the recovered receipt operation ahead of the export transition so
 * the outbox order mirrors the required audit order. A same-id operation is
 * replaced rather than duplicated.
 */
function insertDecisionOperation(state: SessionState, operation: DecisionOperation): SessionState {
  const exportOperationIndex = findExportOperationIndex(state);
  const index =
    exportOperationIndex === -1 ? state.pendingAuditOperations.length : exportOperationIndex;
  const withoutDuplicate = state.pendingAuditOperations.filter(
    (candidate) => candidate.operationId !== operation.operationId,
  );
  return {
    ...state,
    pendingAuditOperations: [
      ...withoutDuplicate.slice(0, index),
      operation,
      ...withoutDuplicate.slice(index),
    ],
  };
}

/**
 * Whether the session's terminal transition is already durable audit
 * evidence. An operation whose append succeeded but whose acknowledgement was
 * lost is durable even though its outbox status is not yet `reconciled`.
 */
async function hasTerminalTransitionEvidence(
  sessDir: string,
  state: SessionState,
): Promise<boolean> {
  const transition = state.transition;
  if (!transition) return false;
  return (await readAuditTrail(sessDir)).some(
    (event) =>
      event.detail.kind === 'transition' &&
      event.detail.from === transition.from &&
      event.detail.to === transition.to &&
      event.detail.event === transition.event &&
      event.occurredAt === transition.at,
  );
}

/** Atomic check-and-commit: exactly one terminal decision intent, even under concurrent recovery. */
export async function commitTerminalDecision(
  sessDir: string,
  sessionID: string,
  state: SessionState,
  auditDeps: AuditDeps,
): Promise<SessionState> {
  await withSessionWriteTransaction(sessDir, async () => {
    const fresh = await readState(sessDir);
    const authority = fresh && isRegulatedTicketCompletion(fresh) ? fresh : state;
    const receipt = await resolveDurableDecisionReceipt(sessDir, authority);
    if (receipt.kind === 'repaired') {
      await writeStateWithArtifactsAndAuditOperations(sessDir, receipt.state);
      return;
    }
    if (receipt.kind === 'correlated') return;
    // A committed intent whose event is not durable yet is drained by the
    // outbox in array order — ahead of the export transition it precedes.
    if (hasPendingTerminalDecision(authority)) return;
    const transition = findApprovalTransition(authority);
    const decision = authority.reviewDecision;
    if (!transition || !decision) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        'Regulated completion requires terminal approval transition and decision authority',
      );
    }
    // The decision receipt must precede the export transition in the audit
    // trail. While that transition is only committed (not yet durably
    // audited), the receipt can be ordered before it. Once the export
    // transition is durable — including a reconciled outbox entry or an
    // append whose acknowledgement was lost — a late receipt would falsify
    // the decision order: fail closed instead of fabricating evidence.
    // Recovery never attributes the receipt to a session actor; the deciding
    // identity is the persisted decisionIdentity.
    const exportOperationIndex = findExportOperationIndex(authority);
    if (exportOperationIndex === -1) {
      throw lateReceiptError();
    }
    const exportOperation = authority.pendingAuditOperations[exportOperationIndex];
    if (exportOperation?.status === 'reconciled') {
      throw lateReceiptError();
    }
    const recovered = await recoverOrderedDecision({
      sessDir,
      sessionID,
      authority,
      transition,
      decision,
      auditDeps,
    });
    if (recovered === null) {
      throw lateReceiptError();
    }
    await writeStateWithArtifactsAndAuditOperations(sessDir, recovered);
  });
  return (await readState(sessDir)) ?? state;
}

/**
 * Serialize the durability decision with every concurrent audit append: hold
 * the audit lock across the trail re-check AND the decision append so no
 * export event can slip between them. Lock order is state -> audit; the audit
 * append path never takes the state lock while holding the audit lock, so the
 * order cannot deadlock.
 *
 * Returns the state with the receipt inserted ahead of the (still
 * non-durable) export operation, or null when the export transition is
 * already durable.
 */
async function recoverOrderedDecision(input: {
  readonly sessDir: string;
  readonly sessionID: string;
  readonly authority: SessionState;
  readonly transition: NonNullable<SessionState['transition']>;
  readonly decision: NonNullable<SessionState['reviewDecision']>;
  readonly auditDeps: AuditDeps;
}): Promise<SessionState | null> {
  const { sessDir, sessionID, authority, transition, decision, auditDeps } = input;
  const decisionSequence = await auditDeps.nextDecisionSequence(sessDir, sessionID);
  const actor =
    resolvePolicyFromSnapshot(authority.policySnapshot).actorClassification[
      TOOL_FLOWGUARD_DECISION
    ] ?? 'system';
  return withAuditTrailLock(sessDir, async (): Promise<SessionState | null> => {
    if (await hasTerminalTransitionEvidence(sessDir, authority)) return null;
    const prepared = prepareAuditOperations(authority, authority, undefined, [
      buildDecisionAuditIntent({
        transition,
        decision,
        policyMode: authority.policySnapshot.mode,
        decisionSequence,
        actor,
      }),
    ]);
    const appended = prepared.pendingAuditOperations.slice(authority.pendingAuditOperations.length);
    const [decisionOperation] = appended;
    if (decisionOperation === undefined || decisionOperation.kind !== 'semantic') {
      throw new PersistenceError(
        'WRITE_FAILED',
        'Regulated completion decision intent could not be prepared',
      );
    }
    await appendDecisionEventUnderAuditLock(sessDir, decisionOperation, authority, auditDeps);
    // The append succeeded, so its operation is reconciled; persist it ahead
    // of the export operation. A crash between the append and this write is
    // repaired from the durable event on the next recovery.
    return insertDecisionOperation(prepared, {
      ...decisionOperation,
      status: 'reconciled' as const,
    });
  });
}

function lateReceiptError(): PersistenceError {
  return new PersistenceError(
    'WRITE_FAILED',
    'Regulated completion terminal decision authority is missing after the export transition was durably audited; refusing to fabricate a late decision receipt',
  );
}

/**
 * Append the recovered decision event under the caller-held audit lock. The
 * event is idempotent by operation id, so a re-delivery after a crash between
 * append and state commit is recognized instead of duplicated. A crash that
 * loses the operation entirely is repaired from the durable event on the next
 * recovery (see resolveDurableDecisionReceipt).
 */
async function appendDecisionEventUnderAuditLock(
  sessDir: string,
  operation: Extract<PendingAuditOperation, { kind: 'semantic' }>,
  state: SessionState,
  auditDeps: AuditDeps,
): Promise<void> {
  const semantic = operation.semantic;
  const prevHash = getLastChainHash(await readAuditTrail(sessDir));
  const body = buildSemanticAuditBody({
    flowguardSessionId: state.flowguardSessionId,
    hostSessionId: state.binding.hostSessionId,
    phase: semantic.phase,
    detail: semantic.detail,
    event: semantic.event,
    occurredAt: semantic.occurredAt,
    prevHash,
    operationId: operation.operationId,
    preStateDigest: operation.preStateDigest,
    mutationDigest: operation.mutationDigest,
    postStateDigest: operation.postStateDigest,
    ...(semantic.actor !== undefined ? { actor: semantic.actor } : {}),
    ...(semantic.actorInfo !== undefined ? { actorInfo: semantic.actorInfo } : {}),
  });
  const digest = computeCanonicalEventDigest(body);
  const timestampAssurance = toTimestampAssurancePolicy(
    state.policySnapshot.audit.timestampAssurance,
  );
  const resolution = timestampAssurance.enabled
    ? await resolveTimestampEvidence({
        policy: timestampAssurance,
        canonicalEventDigest: digest,
        eventKind: 'decision',
        localTimestamp: semantic.occurredAt,
        ...(auditDeps.tsaProvider !== undefined ? { tsaProvider: auditDeps.tsaProvider } : {}),
        ...(auditDeps.timestampVerifier !== undefined
          ? { timestampVerifier: auditDeps.timestampVerifier }
          : {}),
      })
    : undefined;
  if (timestampAssurance.strict && resolution?.error) {
    throw new PersistenceError(
      'WRITE_FAILED',
      `Timestamp assurance failed for the recovered decision receipt: ${resolution.error}`,
    );
  }
  await appendAuditEventAlreadyLocked(
    sessDir,
    finalizeWithTimestampEvidence(body, prevHash, resolution?.evidence, digest),
  );
}

/** Normalize the frozen snapshot policy to the readonly audit policy shape. */
function toTimestampAssurancePolicy(configured: {
  readonly enabled: boolean;
  readonly mode: TimestampAssurancePolicy['mode'];
  readonly strict: boolean;
  readonly criticalEvents: readonly string[];
  readonly ntpDriftThresholdMs: number;
  readonly tsaTimeoutMs: number;
  readonly tsaUrl?: string | undefined;
  readonly trustAnchors?: readonly string[] | undefined;
  readonly ntpServers?: readonly string[] | undefined;
}): TimestampAssurancePolicy {
  return {
    enabled: configured.enabled,
    mode: configured.mode,
    strict: configured.strict,
    criticalEvents: [...configured.criticalEvents],
    ntpDriftThresholdMs: configured.ntpDriftThresholdMs,
    tsaTimeoutMs: configured.tsaTimeoutMs,
    ...(configured.tsaUrl !== undefined ? { tsaUrl: configured.tsaUrl } : {}),
    ...(configured.trustAnchors !== undefined
      ? { trustAnchors: [...configured.trustAnchors] }
      : {}),
    ...(configured.ntpServers !== undefined ? { ntpServers: [...configured.ntpServers] } : {}),
  };
}
