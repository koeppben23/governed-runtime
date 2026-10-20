/**
 * @module integration/reviewer-output-cap-failure
 * @description Persist a terminal reviewer output-cap failure directly from
 *              `chat.params`, before the host can fail the child Task.
 *
 * OpenCode does not guarantee `tool.execute.after` when the Task execution
 * itself throws. The output-cap hook therefore resolves the reviewer child's
 * parent, abandons the exact authorized dispatch, and blocks the obligation in
 * the same synchronous path that aborts the model request. The after-hook map
 * remains a fallback for hosts where parent resolution is unavailable.
 */

import type { SessionAuthorityResolution } from '../adapters/session-authority.js';
import { abandonReviewDispatchByHostCall } from './review/dispatch/durable-dispatch.js';
import {
  blockReviewerOutputCapObligation,
  clearPendingReviewForObligation,
} from './review/dispatch/capture-failure-routing.js';
import type { OrchestratorDeps } from './review/pipeline-types.js';
import type { ReviewerOutputCapFailure, SessionEnforcementState } from './review/types.js';

interface ReviewerOutputCapFailureClient {
  readonly session: {
    get?(opts: { path: { id: string } }): Promise<{
      data?: { id?: string; parentID?: string } | undefined;
      error?: unknown;
    }>;
  };
}

interface ReviewerOutputCapFailureWorkspace {
  resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  getEnforcementState(sessionId: string): SessionEnforcementState;
}

interface ReviewerOutputCapFailureLogger {
  info(service: string, message: string, extra?: Record<string, unknown>): void;
  warn(service: string, message: string, extra?: Record<string, unknown>): void;
  error(service: string, message: string, extra?: Record<string, unknown>): void;
}

export interface ReviewerOutputCapFailureDeps {
  readonly client: ReviewerOutputCapFailureClient;
  readonly ws: ReviewerOutputCapFailureWorkspace;
  readonly orchestratorDeps: OrchestratorDeps;
  readonly log: ReviewerOutputCapFailureLogger;
}

interface ResolvedParentContext {
  readonly parentId: string;
  readonly resolution: Extract<SessionAuthorityResolution, { status: 'resolved' }>;
  readonly enforcement: SessionEnforcementState;
}

interface ResolvedFailureContext extends ResolvedParentContext {
  readonly obligationId: string;
  readonly dispatch: {
    readonly hostCallId: string;
  };
}

async function resolveParentContext(
  deps: ReviewerOutputCapFailureDeps,
  childSessionId: string,
): Promise<ResolvedParentContext | null> {
  const get = deps.client.session.get;
  if (!get) {
    deps.log.warn('review', 'reviewer output cap terminal persistence unavailable', {
      childSessionId,
      reason: 'session.get unavailable',
    });
    return null;
  }

  let parentId: string | undefined;
  try {
    const child = await get({ path: { id: childSessionId } });
    parentId = child.data?.parentID;
  } catch (err) {
    deps.log.warn('review', 'reviewer output cap parent lookup failed', {
      childSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (!parentId || parentId === childSessionId) {
    deps.log.warn('review', 'reviewer output cap parent unavailable', { childSessionId });
    return null;
  }

  let resolution: SessionAuthorityResolution;
  try {
    resolution = await deps.ws.resolveSessionAuthority(parentId);
  } catch (err) {
    deps.log.warn('review', 'reviewer output cap session authority unavailable', {
      childSessionId,
      parentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  if (resolution.status !== 'resolved') {
    deps.log.warn('review', 'reviewer output cap session authority unresolved', {
      childSessionId,
      parentId,
    });
    return null;
  }
  return {
    parentId,
    resolution,
    enforcement: deps.ws.getEnforcementState(parentId),
  };
}

function resolvePendingDispatch(
  deps: ReviewerOutputCapFailureDeps,
  context: ResolvedParentContext,
  childSessionId: string,
): ResolvedFailureContext | null {
  const pendingCandidates = [...context.enforcement.pendingReviews.values()].filter(
    (pending) => pending.obligationId !== null && pending.attemptId !== null,
  );
  if (pendingCandidates.length !== 1) {
    deps.log.warn('review', 'reviewer output cap pending review ambiguous', {
      childSessionId,
      parentId: context.parentId,
      candidates: pendingCandidates.length,
    });
    return null;
  }
  const pending = pendingCandidates[0];
  const obligationId = pending?.obligationId;
  const attemptId = pending?.attemptId;
  if (
    obligationId === null ||
    obligationId === undefined ||
    attemptId === null ||
    attemptId === undefined
  ) {
    return null;
  }

  const dispatch = (context.resolution.state.reviewAssurance?.dispatches ?? []).find(
    (candidate) =>
      candidate.dispatchStatus === 'authorized' &&
      candidate.obligationId === obligationId &&
      candidate.attemptId === attemptId,
  );
  if (!dispatch) {
    deps.log.warn('review', 'reviewer output cap authorized dispatch unavailable', {
      childSessionId,
      parentId: context.parentId,
      obligationId,
    });
    return null;
  }
  return { ...context, obligationId, dispatch };
}

async function persistResolvedFailure(
  deps: ReviewerOutputCapFailureDeps,
  context: ResolvedFailureContext,
  failure: ReviewerOutputCapFailure,
): Promise<boolean> {
  try {
    await abandonReviewDispatchByHostCall(
      deps.orchestratorDeps,
      context.resolution.sessDir,
      context.dispatch.hostCallId,
    );
    await blockReviewerOutputCapObligation(deps.orchestratorDeps, {
      sessDir: context.resolution.sessDir,
      parentSessionId: context.parentId,
      phase: context.resolution.state.phase,
      obligationId: context.obligationId,
      failure,
      output: { output: '' },
    });
    clearPendingReviewForObligation(context.enforcement, context.obligationId);
    deps.log.info('review', 'reviewer output cap blocked', {
      parentId: context.parentId,
      obligationId: context.obligationId,
      code: failure.code,
    });
    return true;
  } catch (err) {
    deps.log.error('review', 'reviewer output cap terminal persistence failed', {
      parentId: context.parentId,
      obligationId: context.obligationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Persist the terminal block for one reviewer child. Returns true only when the
 * exact parent, pending attempt, and authorized dispatch were resolved and the
 * block was written. A false result leaves the in-memory failure for the native
 * Task after-hook fallback.
 */
export function createReviewerOutputCapFailurePersister(
  deps: ReviewerOutputCapFailureDeps,
): (childSessionId: string, failure: ReviewerOutputCapFailure) => Promise<boolean> {
  return async (childSessionId, failure) => {
    const parent = await resolveParentContext(deps, childSessionId);
    if (!parent) return false;
    const context = resolvePendingDispatch(deps, parent, childSessionId);
    if (!context) return false;
    return persistResolvedFailure(deps, context, failure);
  };
}
