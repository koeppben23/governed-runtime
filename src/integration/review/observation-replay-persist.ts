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

import type { SessionState } from '../../state/schema.js';
import type { SemanticAuditIntent } from '../tools/audit-outbox.js';
import { ensureReviewAssurance } from './assurance.js';
import { replayObservationCaptures, type ObservationReplayResult } from './observation-replay.js';

export interface ReplayPersistDeps {
  getSessionDir(sessionId: string): string | null;
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

/** Read-only state access for the replay (dependency-injected for tests). */
export type ReplayStateReader = (sessDir: string) => Promise<SessionState | null>;

export async function replayAndPersistObservations(
  deps: ReplayPersistDeps,
  readPersistedState: ReplayStateReader,
  input: {
    readonly sessionId: string;
    readonly attemptId: string;
    readonly childSessionId: string;
    readonly now: string;
  },
): Promise<void> {
  const sessDir = deps.getSessionDir(input.sessionId);
  if (!sessDir) return;
  const state = await readPersistedState(sessDir);
  if (!state) return;

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
    });
  }
  if (replay.observations.length === 0) return;
  try {
    await deps.updateReviewAssurance(sessDir, (s: SessionState) => {
      const assurance = ensureReviewAssurance(s.reviewAssurance);
      const attempts = assurance.attempts.map((a) =>
        a.attemptId !== input.attemptId
          ? a
          : {
              ...a,
              observations: [...(a.observations ?? []), ...replay.observations],
            },
      );
      return { ...s, reviewAssurance: { ...assurance, attempts } };
    });
    deps.log.info('review', 'observation replay minted authoritative observations', {
      sessionId: input.sessionId,
      attemptId: input.attemptId,
      count: replay.observations.length,
    });
  } catch (err) {
    deps.logError('observation persistence failed', err);
  }
}
