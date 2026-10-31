/**
 * @module integration/reviewer-execution-failure
 * @description Exact, durable execution closure and terminality checks. These
 * operations use the authorized parent/call identity, never a fresh SDK lookup.
 */

import { abandonAndBlockByHostCall } from './review/dispatch/durable-dispatch.js';
import { clearPendingReviewForObligation } from './review/dispatch/capture-failure-routing.js';
import type { OrchestratorDeps } from './review/pipeline-types.js';
import type {
  ReviewerExecutionFailure,
  ReviewerExecutionIdentity,
  SessionEnforcementState,
} from './review/types.js';
import type { SessionAuthorityResolution } from '../adapters/session-authority.js';

export interface ReviewerExecutionFailureDeps {
  readonly ws: {
    resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
    getEnforcementState(sessionId: string): SessionEnforcementState;
  };
  readonly orchestratorDeps: OrchestratorDeps;
  readonly log: {
    error(service: string, message: string, extra?: Record<string, unknown>): void;
  };
}

export function createReviewerExecutionFailurePersister(deps: ReviewerExecutionFailureDeps) {
  return async (
    failure: ReviewerExecutionFailure,
    identity: ReviewerExecutionIdentity,
  ): Promise<boolean> => {
    try {
      const resolution = await deps.ws.resolveSessionAuthority(identity.parentSessionId);
      if (resolution.status !== 'resolved') return false;
      const result = await abandonAndBlockByHostCall(
        deps.orchestratorDeps,
        resolution.sessDir,
        identity.callId,
        failure.code,
        identity.childSessionId === undefined ? {} : { childSessionId: identity.childSessionId },
      );
      if (result.kind === 'unresolved') return false;
      if (result.kind !== 'terminal' || result.status !== 'completed') {
        clearPendingReviewForObligation(
          deps.ws.getEnforcementState(identity.parentSessionId),
          result.obligationId,
        );
      }
      return true;
    } catch (err) {
      deps.log.error('review', 'reviewer execution closure could not be persisted', {
        ...identity,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  };
}
