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
import { writeStateWithArtifactsAndAuditOperations } from '../tools/helpers.js';
import type { SemanticAuditIntent } from '../tools/audit-outbox.js';
import { reconcilePendingAuditOperations, type AuditDeps } from '../plugin-audit.js';
import { getAdapterLogger } from '../../logging/adapter-logger.js';
import { serializeError } from '../../logging/error-serialize.js';
import { isTerminalPhase } from '../../machine/topology.js';

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
): Promise<SessionState> {
  if (!isTerminalPhase(resultState.phase) || resultState.error) {
    return {
      ...resultState,
      regulatedArchiveStatus: 'failed' as const,
      archiveStatus: 'failed' as const,
    };
  }
  getAdapterLogger().info('services', 'Starting regulated completion chain', {
    sessionID,
    fingerprint,
  });

  let current = resultState;
  let finalState: SessionState;
  try {
    // Commit the terminal transition and its human authorization together.
    // Both are state-owned operations before any archive side effect occurs.
    current = await writeStateWithArtifactsAndAuditOperations(sessDir, resultState, undefined, [
      decisionIntent(resultState),
    ]);
    current = await reconcileCompletionAuditOperations(sessDir, sessionID, current);

    // The lifecycle assertion is a separate durable operation so its chain
    // position is necessarily after the reconciled transition and decision.
    current = await writeStateWithArtifactsAndAuditOperations(
      sessDir,
      {
        ...current,
        regulatedArchiveStatus: 'pending' as const,
        archiveStatus: 'pending' as const,
      },
      undefined,
      [lifecycleIntent()],
    );
    current = await reconcileCompletionAuditOperations(sessDir, sessionID, current);

    // The snapshot now contains complete, reconciled completion evidence.
    await archiveRegulatedEvidence(fingerprint, sessionID);
    current = await writeStateWithArtifactsAndAuditOperations(sessDir, {
      ...current,
      regulatedArchiveStatus: 'created' as const,
      archiveStatus: 'created' as const,
    });

    // Archive status is a live projection and intentionally post-dates the
    // immutable archive snapshot it describes.
    const verification = await verifyRegulatedArchive(fingerprint, sessionID);
    finalState = await writeStateWithArtifactsAndAuditOperations(sessDir, {
      ...current,
      regulatedArchiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
      archiveStatus: verification.passed ? ('verified' as const) : ('failed' as const),
    });
    getAdapterLogger().info('services', 'Regulated completion chain finished', {
      sessionID,
      archiveStatus: finalState.regulatedArchiveStatus,
      archivePassed: verification.passed,
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

function decisionIntent(state: SessionState): SemanticAuditIntent {
  const transition = state.transition;
  const decision = state.reviewDecision;
  if (!transition || !decision || transition.from !== 'EVIDENCE_REVIEW') {
    throw new PersistenceError(
      'SCHEMA_VALIDATION_FAILED',
      'Regulated completion requires terminal transition and decision authority',
    );
  }
  const decisionId = `DEC-${transition.at.replace(/[^0-9]/g, '')}`;
  return {
    phase: transition.from,
    event: `decision:${decisionId}`,
    occurredAt: decision.decidedAt,
    detail: {
      kind: 'decision',
      gatePhase: transition.from,
      decisionId,
      decisionSequence: 0,
      verdict: decision.verdict,
      rationale: decision.rationale,
      decidedBy: decision.decidedBy,
      decidedAt: decision.decidedAt,
      fromPhase: transition.from,
      toPhase: transition.to,
      transitionEvent: transition.event,
      policyMode: state.policySnapshot.mode,
    },
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
): Promise<SessionState> {
  const deps: AuditDeps = {
    resolveFingerprint: async () => 'regulated-completion',
    getSessionDir: (candidate) => (candidate === sessionID ? sessDir : null),
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
    nextDecisionSequence: async () => 0,
    log: { debug: () => undefined, info: () => undefined, warn: () => undefined },
    logError: () => undefined,
    cachedFingerprint: 'regulated-completion',
    mode: 'regulated',
  };
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
