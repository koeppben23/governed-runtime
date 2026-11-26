/**
 * @module integration/review/observation-replay-persist
 * @description Persistence step of the parent observation replay.
 *
 * After the completed reviewer child session is known, the attempt's
 * observation ledger is replayed (see observation-replay.ts) and the minted
 * authoritative observations are persisted onto the attempt through the
 * serialized assurance channel. Child captures alone are NEVER authority —
 * this is the single minting/persistence point.
 *
 * @version v1
 */

import type { SessionState } from '../../../state/schema.js';
import type { SessionAuthorityResolution } from '../../../adapters/session-authority.js';
import type { SemanticAuditIntent } from '../../audit-outbox.js';
import { ensureReviewAssurance } from '../../../state/review-dispatch.js';
import {
  replayObservationCaptures,
  observationReplayKey,
  type ObservationReplayResult,
} from './observation-replay.js';
import { buildEnforcementError } from '../../blocked-result.js';
import type { RepositoryObservation } from '../../../state/evidence.js';

function applyReplayedObservations(
  s: SessionState,
  input: { readonly attemptId: string; readonly childSessionId: string },
  observations: readonly RepositoryObservation[],
) {
  const assurance = ensureReviewAssurance(s.reviewAssurance);
  const attempt = assurance.attempts.find((item) => item.attemptId === input.attemptId);
  const obligation = assurance.obligations.find(
    (item) => item.obligationId === attempt?.obligationId,
  );
  if (
    !attempt ||
    attempt.status !== 'created' ||
    attempt.childSessionId !== input.childSessionId ||
    obligation?.status !== 'pending' ||
    assurance.capacityLock
  )
    throw buildEnforcementError(
      'REVIEW_ATTEMPT_UNAVAILABLE',
      'Observation replay lost its exact current child/attempt/obligation lineage.',
    );
  const existing = new Set((attempt.observations ?? []).map(observationReplayKey));
  const added = observations.filter(
    (observation) => !existing.has(observationReplayKey(observation)),
  );
  const attempts = assurance.attempts.map((a) =>
    a.attemptId !== input.attemptId
      ? a
      : {
          ...a,
          observations: [...(a.observations ?? []), ...added],
        },
  );
  return { state: { ...s, reviewAssurance: { ...assurance, attempts } }, count: added.length };
}

export interface ReplayPersistDeps {
  resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  updateReviewAssurance(
    sessDir: string,
    update: (state: SessionState, now: string) => SessionState,
    semanticIntents?: (state: SessionState, now: string) => readonly SemanticAuditIntent[],
  ): Promise<void>;
  log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  logError(message: string, err: unknown): void;
}

export async function replayAndPersistObservations(
  deps: ReplayPersistDeps,
  input: {
    readonly sessionId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly now: string;
  },
): Promise<void> {
  const resolution = await deps.resolveSessionAuthority(input.sessionId);
  if (resolution.status !== 'resolved') return;
  const { sessDir, state } = resolution;

  let replay: ObservationReplayResult;
  try {
    replay = await replayObservationCaptures({
      state,
      worktree: state.binding.worktree,
      attemptId: input.attemptId,
      childSessionId: input.childSessionId,
      now: input.now,
    });
  } catch (err) {
    // Replay failure must never fabricate observations: log and continue
    // without authority. Evidence binding fails closed downstream.
    deps.logError('observation replay failed', err);
    return;
  }
  if (replay.dropped > 0) {
    deps.log.warn('review', 'observation captures dropped during replay', {
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      dropped: replay.dropped,
      reasons: replay.dropReasons,
    });
  }
  if (replay.responseMismatches.length > 0) {
    // Visible cause for a later REVIEW_EVIDENCE_NOT_OBSERVED: the captured
    // payload is not the current canonical observation response (for example a
    // capture recorded before an observation-response format change). It is
    // never reinterpreted as authority.
    deps.log.warn(
      'review',
      'observation capture response differs from the current canonical observation response',
      {
        sessionId: input.sessionId,
        attemptId: input.attemptId,
        locations: replay.responseMismatches
          .slice(0, 8)
          .map((entry) => `${entry.revision}:${entry.path}`)
          .join(', '),
      },
    );
  }
  if (replay.observations.length === 0) return;
  let persistedCount = 0;
  try {
    await deps.updateReviewAssurance(sessDir, (s: SessionState) => {
      const applied = applyReplayedObservations(s, input, replay.observations);
      persistedCount = applied.count;
      return applied.state;
    });
    deps.log.info('review', 'observation replay minted authoritative observations', {
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      count: persistedCount,
    });
  } catch (err) {
    deps.logError('observation persistence failed', err);
  }
}
