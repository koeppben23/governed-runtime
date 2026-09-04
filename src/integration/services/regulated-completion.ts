/**
 * @module integration/services/regulated-completion
 * @description P26 regulated archive lifecycle: audit emit → archive → verify.
 *
 * Scope: EVIDENCE_REVIEW + APPROVE → COMPLETE in regulated mode.
 * Fail-closed: any failure in the chain produces regulatedArchiveStatus: 'failed'.
 * No partial success can leak — the entire chain is atomic from the caller's perspective.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import { archiveRegulatedEvidence } from '../../adapters/workspace/archive.js';
import { verifyRegulatedArchive } from '../../adapters/workspace/archive-verify-chain.js';
import { readState, PersistenceError } from '../../adapters/persistence.js';
import { appendAuditEvent, readAuditTrail } from '../../adapters/persistence-audit.js';
import { getLastChainHash } from '../../audit/integrity.js';
import { HttpTimestampAuthorityProvider } from '../../audit/rfc-3161-http-provider.js';
import { PkijsTimestampVerifier } from '../../audit/rfc-3161-pkijs-verifier.js';
import {
  writeStateWithArtifactsAndAuditOperations,
  withSessionWriteTransaction,
} from '../tools/helpers.js';
import type { SemanticAuditIntent } from '../tools/audit-outbox.js';
import { reconcilePendingAuditOperations, type AuditDeps } from '../plugin-audit.js';
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
      policy: state.policySnapshot,
      state: await readState(sessDir),
    }),
    initChain: async () => getLastChainHash((await readAuditTrail(sessDir)).events),
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
    nextDecisionSequence: async () =>
      (await readAuditTrail(sessDir)).events.reduce((max, event) => {
        const sequence =
          event.detail.kind === 'decision' && typeof event.detail.decisionSequence === 'number'
            ? event.detail.decisionSequence
            : 0;
        return Math.max(max, sequence);
      }, 0) + 1,
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
    state.policySnapshot.mode === 'regulated' &&
    !state.error &&
    state.transition?.from === 'EVIDENCE_REVIEW' &&
    state.transition?.event === 'APPROVE'
  );
}

/**
 * Execute the P26 regulated completion chain: durable authority commit →
 * reconciliation → archive → verify.
 *
 * Pre-conditions (caller must verify before calling):
 * - Rail result kind === 'ok'
 * - Pre-decision phase was EVIDENCE_REVIEW
 * - Verdict was 'approve'
 * - result.state.phase === 'COMPLETE'
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
    getAdapterLogger().error('services', 'Regulated completion chain failed', {
      sessionID,
      fingerprint,
      error: serializeError(err),
    });
    finalState = {
      ...current,
      regulatedArchiveStatus: 'failed' as const,
      archiveStatus: 'failed' as const,
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

async function archiveAndVerify(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  state: SessionState,
  auditDeps: AuditDeps,
): Promise<SessionState> {
  let current = state;
  if (current.archiveStatus !== 'created' && current.archiveStatus !== 'verified') {
    await archiveRegulatedEvidence(fingerprint, sessionID);
    current = await writeStateWithArtifactsAndAuditOperations(sessDir, {
      ...current,
      regulatedArchiveStatus: 'created' as const,
      archiveStatus: 'created' as const,
    });
  }
  const verification = await verifyRegulatedArchive(fingerprint, sessionID);
  const finalState = await writeStateWithArtifactsAndAuditOperations(sessDir, {
    ...current,
    regulatedArchiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
    archiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
  });
  return reconcileCompletionAuditOperations(sessDir, sessionID, finalState, auditDeps);
}

export async function resumeRegulatedCompletion(
  sessDir: string,
  fingerprint: string,
  sessionID: string,
  auditDeps: AuditDeps,
): Promise<SessionState | null> {
  const state = await readState(sessDir);
  if (!state || !isRegulatedTicketCompletion(state) || state.archiveStatus === 'verified') {
    return null;
  }
  return executeRegulatedCompletion(sessDir, fingerprint, sessionID, state, auditDeps);
}

function isTerminalDecisionDetail(detail: Record<string, unknown>, state: SessionState): boolean {
  const transition = state.transition;
  const decision = state.reviewDecision;
  if (!transition || !decision || transition.from !== 'EVIDENCE_REVIEW') return false;
  return (
    detail.kind === 'decision' &&
    detail.fromPhase === transition.from &&
    detail.toPhase === transition.to &&
    detail.transitionEvent === transition.event &&
    detail.verdict === decision.verdict &&
    detail.rationale === decision.rationale &&
    detail.decidedBy === decision.decidedBy &&
    detail.decidedAt === decision.decidedAt
  );
}

async function hasTerminalDecisionEvidence(sessDir: string, state: SessionState): Promise<boolean> {
  return (await readAuditTrail(sessDir)).events.some((event) =>
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
    await writeStateWithArtifactsAndAuditOperations(sessDir, authority, undefined, [
      await decisionIntent(sessDir, authority, auditDeps, sessionID),
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
  return (await readAuditTrail(sessDir)).events.some(
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
        archiveStatus: 'pending' as const,
      },
      undefined,
      [lifecycleIntent()],
    );
  });
  return (await readState(sessDir)) ?? state;
}

async function decisionIntent(
  sessDir: string,
  state: SessionState,
  auditDeps: AuditDeps,
  sessionID: string,
): Promise<SemanticAuditIntent> {
  const transition = state.transition;
  const decision = state.reviewDecision;
  if (!transition || !decision || transition.from !== 'EVIDENCE_REVIEW') {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      'Regulated completion requires terminal transition and decision authority',
    );
  }
  const decisionSequence = await auditDeps.nextDecisionSequence(sessDir, sessionID);
  const decisionId = `DEC-${String(decisionSequence).padStart(3, '0')}`;
  return {
    phase: transition.from,
    event: `decision:${decisionId}`,
    occurredAt: decision.decidedAt,
    detail: {
      kind: 'decision',
      gatePhase: transition.from,
      decisionId,
      decisionSequence,
      verdict: decision.verdict,
      rationale: decision.rationale,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      fromPhase: transition.from,
      toPhase: transition.to,
      transitionEvent: transition.event,
      policyMode: state.policySnapshot.mode,
      decisionIdentity: decision.decisionIdentity,
    },
    actor: decision.decisionIdentity?.actorId ?? decision.decidedBy,
    ...(state.actorInfo ? { actorInfo: state.actorInfo } : {}),
  };
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
  const outcome = await reconcilePendingAuditOperations(deps, sessionID, 'flowguard_decision');
  if (outcome?.auditOk === false) {
    throw new PersistenceError('WRITE_FAILED', outcome.reason ?? 'Audit reconciliation failed');
  }
  const reconciled = await readState(sessDir);
  if (
    !reconciled ||
    reconciled.pendingAuditOperations.some((item) => item.status !== 'reconciled')
  ) {
    throw new PersistenceError(
      'WRITE_FAILED',
      'Regulated completion audit operations remain unreconciled',
    );
  }
  return reconciled;
}
