/**
 * @module integration/review/native-review-types
 * @description Shared persisted-state and structural runtime types for the
 * native reviewer dispatch, capture and closure owners.
 */

import type { readState } from '../../../adapters/persistence.js';
import type { SessionAuthorityResolution } from '../../../adapters/session-authority.js';
import type { SessionEnforcementState } from '../types.js';
import type { OrchestratorDeps } from '../pipeline-types.js';

export type PersistedState = NonNullable<Awaited<ReturnType<typeof readState>>>;

/**
 * Structural host runtime the native reviewer owners need. review/ must not
 * import plugin-* (FG-QUAL-002); the host caller passes its full runtime, which
 * satisfies this subset structurally.
 */
export interface NativeReviewTransportRuntime {
  readonly ws: {
    getEnforcementState(sessionId: string): SessionEnforcementState;
    resolveSessionAuthority(sessionId: string): Promise<SessionAuthorityResolution>;
  };
  readonly orchestratorDeps: OrchestratorDeps;
  /** Absolute dispatch deadline used to reconcile expired authorized releases. */
  readonly reviewerExecutionTimeoutMs?: number;
  readonly log: {
    info(service: string, message: string, extra?: Record<string, unknown>): void;
    warn(service: string, message: string, extra?: Record<string, unknown>): void;
  };
  readonly logError: (message: string, err: unknown) => void;
}
