/**
 * @module integration/services/regulated-completion
 * @description P26 regulated archive lifecycle: audit emit → archive → verify.
 *
 * Scope: the regulated export/completion path. Approval stops at EXPORT_READY;
 * the canonical export rail materializes and verifies the completion package and
 * persists EXPORT_READY + EXPORT_MATERIALIZED → COMPLETE. This chain then binds
 * the completion evidence (approval decision, session_completed, regulated
 * archive) to that terminal state.
 * Fail-closed: any failure in the chain produces regulatedArchiveStatus: 'failed'.
 * No partial success can leak — the entire chain is atomic from the caller's perspective.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { resolvePolicyFromSnapshot } from '../../config/policy.js';
import { DecisionIdentity } from '../../state/evidence-identity.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { archiveRegulatedEvidence } from '../../adapters/workspace/archive.js';
import { verifyRegulatedArchive } from '../../adapters/workspace/archive-verify-chain.js';
import { readState, PersistenceError } from '../../adapters/persistence.js';
import { acquireNamedWriteLock } from '../../adapters/persistence-lock.js';
import { appendAuditEvent, readAuditTrail } from '../../adapters/persistence-audit.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { HttpTimestampAuthorityProvider } from '../../audit/rfc-3161-http-provider.js';
import { PkijsTimestampVerifier } from '../../audit/rfc-3161-pkijs-verifier.js';
import {
  writeStateWithArtifactsAndAuditOperations,
  withSessionWriteTransaction,
} from '../tools/helpers.js';
import type { SemanticAuditIntent } from '../audit-outbox.js';
import { reconcilePendingAuditOperations, type AuditDeps } from '../plugin-audit.js';
import { buildDecisionAuditIntent, resolveDecisionSequence } from './decision-audit-intent.js';
import { TOOL_FLOWGUARD_DECISION } from '../tool-names.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { serializeError } from '../../logging/error-serialize.js';

/**
 * Session-scoped audit dependencies for completion paths that run outside the
 * plugin runtime (standalone tools, MCP server). Built from the same canonical
 * primitives as the plugin composition root: real RFC 3161 TSA dependencies,
 * the persisted audit trail, and the resolved workspace fingerprint. Never a
 * registry substitute for the plugin runtime's own `AuditDeps`.
 */
export function createSessionCompletionAuditDeps(input: {
  readonly sessDir: string;
  readonly sessionID: string;
  readonly fingerprint: string;
  readonly state: SessionState;
}): AuditDeps {
  const { sessDir, sessionID, fingerprint, state } = input;
  return {
    resolveFingerprint: async () => fingerprint,
    getSessionDir: (candidate) => (candidate === sessionID ? sessDir : null),
    resolveCanonicalSessionDir: async () => ({ status: 'resolved', sessDir }),
    resolveSessionPolicy: async () => ({
      policy: resolvePolicyFromSnapshot(state.policySnapshot),
      state: await readState(sessDir),
    }),
    initChain: async () => getLastChainHash(await readAuditTrail(sessDir)),
    invalidateChainState: () => undefined,
    appendAndTrack: async (event) => {
      const {
        auditFormatVersion: _format,
        auditSequence: _sequence,
        recordedAt: _recordedAt,
        semanticEventDigest: _semanticDigest,
        prevHash: _previous,
        chainHash: _chainHash,
        ...body
      } = event as Record<string, unknown>;
      const appended = await appendAuditEvent(
        sessDir,
        body as import('../../state/evidence.js').AuditEventBody,
      );
      event.chainHash = appended.chainHash;
    },
    nextDecisionSequence: async () => {
      const events = await readAuditTrail(sessDir);
      const current = await readState(sessDir);
      return resolveDecisionSequence(events, current?.pendingAuditOperations ?? []);
    },
    log: {
      debug: () => undefined,
      info: (service, message, extra) => getAdapterLogger().info(service, message, extra),
      warn: (service, message, extra) => getAdapterLogger().warn(service, message, extra),
    },
    logError: (message, err) =>
      getAdapterLogger().error('services', message, { error: serializeError(err) }),
    cachedFingerprint: fingerprint,
    mode: state.policySnapshot.mode,
    tsaProvider: new HttpTimestampAuthorityProvider(),
    timestampVerifier: new PkijsTimestampVerifier(),
  };
}

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

/**
 * Execute the P26 regulated completion chain: durable authority commit →
 * reconciliation → archive → verify.
 *
 * Pre-conditions (caller must verify before calling):
 * - Rail result kind === 'ok'
 * - result.state.phase === 'COMPLETE'
 * - result.state.transition was EXPORT_READY + EXPORT_MATERIALIZED
 * - result.state.policySnapshot.mode === 'regulated'
 * - !result.state.error
 *
 * Fail-closed semantics:
 * - Writes regulatedArchiveStatus 'pending' before starting the chain.
 * - On any failure in the chain, returns state with regulatedArchiveStatus 'failed'.
 * - Only returns 'verified' when archive passes integrity check.
 *
 * @param sessDir - Session directory path
 * @param fingerprint - Workspace fingerprint
 * @param sessionID - Session identifier
 * @param resultState - The COMPLETE state from the rail
 * @returns Final state with regulatedArchiveStatus set
 */
export async function executeRegulatedCompletion(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  resultState: SessionState,
  auditDeps: AuditDeps,
): Promise<SessionState> {
  if (!isRegulatedTicketCompletion(resultState)) {
    return resultState;
  }
  getAdapterLogger().info('services', 'Starting regulated completion chain', {
    sessionID,
    fingerprint,
  });
  // A prior attempt may have committed terminal authority before crashing.
  // The durable outbox checkpoint is the recovery authority: reconcile it
  // FIRST, then decide from exact terminal audit evidence whether a new
  // intent is required. Kind-only trail inspection would treat earlier
  // PLAN_REVIEW decisions or session_created lifecycles as terminal evidence.
  const persisted = await readState(sessDir);
  const resuming = persisted !== null && isRegulatedTicketCompletion(persisted);
  let current = resuming ? persisted : resultState;
  let finalState: SessionState;
  try {
    if (resuming) {
      current = await reconcileCompletionAuditOperations(sessDir, sessionID, current, auditDeps);
    }
    // The terminal decision check and its state-owned commit are one atomic
    // locked transaction: a concurrent recovery must not both observe the
    // evidence gap and each create a second terminal intent.
    current = await commitTerminalDecision(sessDir, sessionID, current, auditDeps);
    current = await reconcileCompletionAuditOperations(sessDir, sessionID, current, auditDeps);

    // The lifecycle assertion is a separate durable operation so its chain
    // position is necessarily after the reconciled transition and decision.
    current = await commitCompletionLifecycle(sessDir, current);
    current = await reconcileCompletionAuditOperations(sessDir, sessionID, current, auditDeps);
    finalState = await archiveAndVerify(sessDir, fingerprint, sessionID, current, auditDeps);
    getAdapterLogger().info('services', 'Regulated completion chain finished', {
      sessionID,
      archiveStatus: finalState.regulatedArchiveStatus,
      archivePassed: finalState.regulatedArchiveStatus === 'verified',
    });
  } catch (err) {
    // Completion-lock contention is not a domain failure: another recovery is
    // legitimately working. Never persist a stale failed status over it — if
    // that recovery already verified, return its state; otherwise surface the
    // contention so the caller can retry.
    if (err instanceof RegulatedCompletionLockContentionError) {
      const fresh = await readState(sessDir);
      if (fresh?.regulatedArchiveStatus === 'verified') {
        return fresh;
      }
      throw err;
    }
    getAdapterLogger().error('services', 'Regulated completion chain failed', {
      sessionID,
      fingerprint,
      error: serializeError(err),
    });
    finalState = {
      ...current,
      regulatedArchiveStatus: 'failed' as const,
    };
    try {
      finalState = await writeStateWithArtifactsAndAuditOperations(sessDir, finalState);
    } catch (persistError) {
      getAdapterLogger().error('services', 'Could not persist regulated completion failure', {
        sessionID,
        error: serializeError(persistError),
      });
    }
  }

  return finalState;
}

/**
 * Archive publication and verification are the last external side-effect
 * boundary of the chain. They are serialized with their own session-scoped
 * lock (NOT the non-reentrant state write lock) so a concurrent recovery
 * re-reads the freshly persisted status on entry and returns immediately once
 * verified — never re-publishing bytes that were already bound to a verified
 * state, and never verifying bytes that a later publisher could replace.
 */
const REGULATED_COMPLETION_LOCK = 'regulated-completion.lock';

/**
 * Archive creation, publication, and verification can legitimately outlast
 * the default 10s session-lock budget (tar alone is bounded at 30s). The
 * completion lock therefore gets a distinctly longer timeout so routine
 * contention does not trip it.
 */
const REGULATED_COMPLETION_LOCK_TIMEOUT_MS = 60_000;

/**
 * Contention on the completion lock is NOT a domain completion failure: a
 * concurrent recovery is legitimately working. The completion chain must
 * never persist a stale `failed` status over that work.
 */
class RegulatedCompletionLockContentionError extends Error {
  readonly code = 'REGULATED_COMPLETION_LOCK_CONTENTION' as const;

  constructor(cause: unknown) {
    super(cause instanceof Error ? cause.message : String(cause));
    this.name = 'RegulatedCompletionLockContentionError';
  }
}

async function withRegulatedCompletionLock<T>(sessDir: string, fn: () => Promise<T>): Promise<T> {
  let lock: Awaited<ReturnType<typeof acquireNamedWriteLock>>;
  try {
    lock = await acquireNamedWriteLock(
      sessDir,
      REGULATED_COMPLETION_LOCK,
      'regulated completion',
      REGULATED_COMPLETION_LOCK_TIMEOUT_MS,
    );
  } catch (err) {
    if (err instanceof PersistenceError && err.code === 'LOCK_TIMEOUT') {
      throw new RegulatedCompletionLockContentionError(err);
    }
    throw err;
  }
  try {
    return await fn();
  } finally {
    await lock.release();
  }
}

async function archiveAndVerify(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  state: SessionState,
  auditDeps: AuditDeps,
): Promise<SessionState> {
  return withRegulatedCompletionLock(sessDir, async () => {
    // A concurrent recovery may have finished the chain while this caller was
    // progressing toward the archive phase. The verified status is the
    // durable exactly-once authority: return it without touching the
    // published artifacts.
    const fresh = await readState(sessDir);
    if (fresh?.regulatedArchiveStatus === 'verified') {
      return fresh;
    }
    let current = fresh ?? state;
    if (
      current.regulatedArchiveStatus !== 'created' &&
      current.regulatedArchiveStatus !== 'verified'
    ) {
      await archiveRegulatedEvidence(fingerprint, sessionID);
      current = await writeStateWithArtifactsAndAuditOperations(sessDir, {
        ...current,
        regulatedArchiveStatus: 'created' as const,
      });
    }
    const verification = await verifyRegulatedArchive(fingerprint, sessionID);
    const finalState = await writeStateWithArtifactsAndAuditOperations(sessDir, {
      ...current,
      regulatedArchiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
    });
    return reconcileCompletionAuditOperations(sessDir, sessionID, finalState, auditDeps);
  });
}

export async function resumeRegulatedCompletion(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  auditDeps: AuditDeps,
): Promise<SessionState | null> {
  const state = await readState(sessDir);
  if (
    !state ||
    !isRegulatedTicketCompletion(state) ||
    state.regulatedArchiveStatus === 'verified'
  ) {
    return null;
  }
  return executeRegulatedCompletion(sessDir, fingerprint, sessionID, state, auditDeps);
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

async function hasTerminalDecisionEvidence(sessDir: string, state: SessionState): Promise<boolean> {
  return (await readAuditTrail(sessDir)).some((event) =>
    isTerminalDecisionDetail(event.detail, state),
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

async function hasTerminalDecisionAuthority(
  sessDir: string,
  state: SessionState,
): Promise<boolean> {
  return (await hasTerminalDecisionEvidence(sessDir, state)) || hasPendingTerminalDecision(state);
}

/** Atomic check-and-commit: exactly one terminal decision intent, even under concurrent recovery. */
async function commitTerminalDecision(
  sessDir: string,
  sessionID: string,
  state: SessionState,
  auditDeps: AuditDeps,
): Promise<SessionState> {
  await withSessionWriteTransaction(sessDir, async () => {
    const fresh = await readState(sessDir);
    const authority = fresh && isRegulatedTicketCompletion(fresh) ? fresh : state;
    if (await hasTerminalDecisionAuthority(sessDir, authority)) return;
    const transition = findApprovalTransition(authority);
    const decision = authority.reviewDecision;
    if (!transition || !decision) {
      throw new PersistenceError(
        'SCHEMA_VALIDATION_FAILED',
        'Regulated completion requires terminal approval transition and decision authority',
      );
    }
    const decisionSequence = await auditDeps.nextDecisionSequence(sessDir, sessionID);
    await writeStateWithArtifactsAndAuditOperations(sessDir, authority, undefined, [
      buildDecisionAuditIntent({
        transition,
        decision,
        policyMode: authority.policySnapshot.mode,
        decisionSequence,
        ...(authority.actorInfo !== undefined ? { actorInfo: authority.actorInfo } : {}),
      }),
    ]);
  });
  return (await readState(sessDir)) ?? state;
}

function isTerminalLifecycleDetail(detail: Record<string, unknown>, state: SessionState): boolean {
  return (
    detail.action === 'session_completed' &&
    detail.kind === 'lifecycle' &&
    detail.finalPhase === state.phase
  );
}

async function hasTerminalLifecycleEvidence(
  sessDir: string,
  state: SessionState,
): Promise<boolean> {
  return (await readAuditTrail(sessDir)).some(
    (event) =>
      event.event === 'lifecycle:session_completed' &&
      isTerminalLifecycleDetail(event.detail, state),
  );
}

function hasPendingTerminalLifecycle(state: SessionState): boolean {
  return state.pendingAuditOperations.some(
    (operation) =>
      operation.kind === 'semantic' &&
      operation.status !== 'reconciled' &&
      operation.semantic.event === 'lifecycle:session_completed' &&
      isTerminalLifecycleDetail(operation.semantic.detail, state),
  );
}

/** Atomic check-and-commit: exactly one session_completed intent, even under concurrent recovery. */
async function commitCompletionLifecycle(
  sessDir: string,
  state: SessionState,
): Promise<SessionState> {
  await withSessionWriteTransaction(sessDir, async () => {
    const fresh = await readState(sessDir);
    const authority = fresh ?? state;
    if (
      (await hasTerminalLifecycleEvidence(sessDir, authority)) ||
      hasPendingTerminalLifecycle(authority)
    ) {
      return;
    }
    await writeStateWithArtifactsAndAuditOperations(
      sessDir,
      {
        ...authority,
        regulatedArchiveStatus: 'pending' as const,
      },
      undefined,
      [lifecycleIntent()],
    );
  });
  return (await readState(sessDir)) ?? state;
}

function lifecycleIntent(): SemanticAuditIntent {
  return {
    phase: 'COMPLETE',
    event: 'lifecycle:session_completed',
    occurredAt: new Date().toISOString(),
    detail: { kind: 'lifecycle', action: 'session_completed', finalPhase: 'COMPLETE' },
  };
}

async function reconcileCompletionAuditOperations(
  sessDir: string,
  sessionID: string,
  state: SessionState,
  deps: AuditDeps,
): Promise<SessionState> {
  // A concurrent recovery may commit its own outbox operations between this
  // chain's drain and the strict post-check. The drain and the acknowledges
  // are idempotent, so a bounded retry loop converges instead of treating
  // legitimate concurrency as a completion failure.
  let reconciled: SessionState | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const outcome = await reconcilePendingAuditOperations(deps, sessionID, TOOL_FLOWGUARD_DECISION);
    if (outcome?.auditOk === false) {
      throw new PersistenceError('WRITE_FAILED', outcome.reason ?? 'Audit reconciliation failed');
    }
    reconciled = await readState(sessDir);
    if (!reconciled) {
      throw new PersistenceError(
        'WRITE_FAILED',
        'Regulated completion audit operations cannot be verified: state unavailable',
      );
    }
    if (reconciled.pendingAuditOperations.every((item) => item.status === 'reconciled')) {
      return reconciled;
    }
  }
  throw new PersistenceError(
    'WRITE_FAILED',
    'Regulated completion audit operations remain unreconciled',
  );
}
