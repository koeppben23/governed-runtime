/**
 * @module integration/review/native-task-review-types
 * @description Shared persisted-state types for the native reviewer Task transport.
 */

import type { readState } from '../../../adapters/persistence.js';
import type { SessionAuthorityResolution } from '../../../adapters/session-authority.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { findBindableAttempt } from '../../../state/review-continuation.js';
import type {
  ReviewerCompletionFailureCode,
  ReviewerOutputCapFailure,
  ReviewerExecutionFailure,
  SessionEnforcementState,
} from '../types.js';
import type { OrchestratorDeps } from '../pipeline-types.js';

export type ReviewerTaskCompletion =
  | { readonly kind: 'completed'; readonly steps: number }
  | {
      readonly kind: 'incomplete';
      readonly code: ReviewerCompletionFailureCode;
      /** Host facts behind the decision, e.g. `steps=5; finish=length; error=none`. */
      readonly detail: string;
    };

/** Every blocked code the same-child structured follow-up can return. */
export type StructuredFollowupFailureCode =
  | 'STRUCTURED_REVIEW_CAPABILITY_UNAVAILABLE'
  | 'STRUCTURED_REVIEW_EXECUTION_MODE_INCOMPATIBLE'
  | 'HOST_STRUCTURED_OUTPUT_REQUIRED'
  | 'HOST_STRUCTURED_OUTPUT_CONTRACT_VIOLATION';

export type PersistedState = NonNullable<Awaited<ReturnType<typeof readState>>>;

type BindableAttempt = NonNullable<ReturnType<typeof findBindableAttempt>>;

export interface NativeReviewLineage {
  readonly state: PersistedState;
  readonly obligation: ReviewObligation;
  readonly attempt: BindableAttempt;
  readonly dispatch: NonNullable<PersistedState['reviewAssurance']>['dispatches'][number];
}

/**
 * Structural host runtime the native Task transport needs. review/ must not
 * import plugin-* (FG-QUAL-002); the host caller passes its full runtime, which
 * satisfies this subset structurally.
 */
export interface NativeReviewTransportRuntime {
  readonly ws: {
    getEnforcementState(sessionId: string): SessionEnforcementState;
    resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  };
  readonly orchestratorDeps: OrchestratorDeps;
  /** Bounded reviewer output-cap failures, keyed by reviewer child session. */
  readonly reviewerOutputCapFailures: Map<string, ReviewerOutputCapFailure>;
  /** Watchdog failures that could not be persisted before the after-hook. */
  readonly reviewerExecutionFailures?: Map<string, ReviewerExecutionFailure>;
  /** Absolute dispatch deadline used to reconcile expired authorized releases. */
  readonly reviewerExecutionTimeoutMs?: number;
  readonly log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  readonly logError: (message: string, err: unknown) => void;
}
