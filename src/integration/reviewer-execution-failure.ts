/**
 * @module integration/reviewer-execution-failure
 * @description Persist a terminal reviewer execution timeout against the exact
 * authorized dispatch. A missing or ambiguous lineage never triggers a blind
 * block or a different review; the watchdog keeps an in-memory fallback for
 * the native after-hook.
 */

import { abandonAndBlockByHostCall } from './review/dispatch/durable-dispatch.js';
import { clearPendingReviewForObligation } from './review/dispatch/capture-failure-routing.js';
import type { OrchestratorDeps } from './review/pipeline-types.js';
import type {
  OrchestratorClient,
  ReviewerExecutionFailure,
  SessionEnforcementState,
} from './review/types.js';
import type { SessionAuthorityResolution } from '../adapters/session-authority.js';

interface Workspace {
  resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
}

interface Logger {
  info(service: string, message: string, extra?: Record<string, unknown>): void;
  warn(service: string, message: string, extra?: Record<string, unknown>): void;
  error(service: string, message: string, extra?: Record<string, unknown>): void;
}

export interface ReviewerExecutionFailureDeps {
  readonly client: Pick<OrchestratorClient, 'session'>;
  readonly ws: Workspace;
  readonly orchestratorDeps: OrchestratorDeps;
  readonly log: Logger;
}

/**
 * Resolve the exact child -> parent -> pending attempt -> authorized dispatch
 * chain. If any link is ambiguous, return false and do not touch state.
 */
export function createReviewerExecutionFailurePersister(
  deps: ReviewerExecutionFailureDeps,
): (failure: ReviewerExecutionFailure, childSessionId: string) => Promise<boolean> {
  // eslint-disable-next-line complexity -- exact lineage resolution is fail-closed.
  return async (failure, childSessionId) => {
    const get = deps.client.session.get;
    if (!get) return false;
    let child: Awaited<ReturnType<NonNullable<typeof get>>>;
    try {
      child = await get({ path: { id: childSessionId } });
    } catch (err) {
      deps.log.warn('review', 'reviewer execution child lookup failed', {
        childSessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
    const parentId = child.data?.parentID;
    if (!parentId || parentId === childSessionId) return false;

    let resolution: SessionAuthorityResolution;
    try {
      resolution = await deps.ws.resolveSessionAuthority(parentId);
    } catch {
      return false;
    }
    if (resolution.status !== 'resolved') return false;
    const enforcement = deps.ws.getEnforcementState(parentId);
    const pending = [...enforcement.pendingReviews.values()].filter(
      (entry) => entry.obligationId !== null && entry.attemptId !== null,
    );
    if (pending.length !== 1) return false;
    const current = pending[0];
    const obligationId = current?.obligationId;
    const attemptId = current?.attemptId;
    if (!obligationId || !attemptId) return false;
    const dispatch = (resolution.state.reviewAssurance?.dispatches ?? []).find(
      (entry) =>
        entry.dispatchStatus === 'authorized' &&
        entry.obligationId === obligationId &&
        entry.attemptId === attemptId,
    );
    if (!dispatch) return false;

    try {
      const result = await abandonAndBlockByHostCall(
        deps.orchestratorDeps,
        resolution.sessDir,
        dispatch.hostCallId,
        failure.code,
        { childSessionId },
      );
      if (result.kind !== 'blocked') return false;
      clearPendingReviewForObligation(enforcement, obligationId);
      deps.log.info('review', 'reviewer execution failure blocked obligation', {
        parentId,
        obligationId,
        childSessionId,
        code: failure.code,
        phase: failure.phase,
      });
      return true;
    } catch (err) {
      deps.log.error('review', 'reviewer execution failure persistence failed', {
        parentId,
        obligationId,
        childSessionId,
        code: failure.code,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}

/**
 * Persist a timeout that fired before the child identity was observed. The
 * authorized dispatch is still exact and durable; no blind child/session action
 * is taken.
 */
export function createReviewerExecutionTaskFailurePersister(
  deps: ReviewerExecutionFailureDeps,
): (
  failure: ReviewerExecutionFailure,
  parentSessionId: string,
  callId: string,
) => Promise<boolean> {
  return async (failure, parentSessionId, callId) => {
    let resolution: SessionAuthorityResolution;
    try {
      resolution = await deps.ws.resolveSessionAuthority(parentSessionId);
    } catch {
      return false;
    }
    if (resolution.status !== 'resolved') return false;
    const dispatch = (resolution.state.reviewAssurance?.dispatches ?? []).find(
      (entry) => entry.dispatchStatus === 'authorized' && entry.hostCallId === callId,
    );
    if (!dispatch) return false;
    try {
      const result = await abandonAndBlockByHostCall(
        deps.orchestratorDeps,
        resolution.sessDir,
        callId,
        failure.code,
      );
      if (result.kind !== 'blocked') return false;
      clearPendingReviewForObligation(
        deps.ws.getEnforcementState(parentSessionId),
        result.obligationId,
      );
      deps.log.info('review', 'reviewer dispatch timeout blocked obligation', {
        parentSessionId,
        callId,
        obligationId: result.obligationId,
        code: failure.code,
      });
      return true;
    } catch (err) {
      deps.log.error('review', 'reviewer dispatch timeout persistence failed', {
        parentSessionId,
        callId,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}
