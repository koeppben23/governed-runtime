/**
 * @module integration/review/discovery-drift-port
 * @description Structural port for the advisory Discovery drift projection.
 *
 * The drift projection is owned by the discovery context. review/ must not
 * import a sibling integration context, so the host/command layer injects a
 * provider; review only consumes the structural result. This module has no
 * imports.
 *
 * @version v1
 */

export type ReviewDiscoveryDriftStatus =
  'clean' | 'drifted' | 'missing_discovery' | 'unavailable' | 'timeout' | 'not_checked';

/** Advisory drift projection as consumed by reviewer prompt construction. */
export interface ReviewDiscoveryDriftProjection {
  readonly status: ReviewDiscoveryDriftStatus;
  readonly drifted: boolean | null;
  readonly currentDigest: string | null;
  readonly persistedDigest: string | null;
  readonly changedContributorNames: readonly string[];
  readonly notVerified: readonly string[];
  readonly diagnostics: readonly string[];
  readonly warnings: readonly { readonly code: string; readonly message: string }[];
}

/** Injected Discovery drift authority used by the review context loader. */
export interface ReviewDiscoveryDriftProvider {
  build(input: {
    readonly workspaceDir: string;
    readonly worktree: string;
    readonly fingerprint: string;
    readonly timeoutMs?: number;
  }): Promise<ReviewDiscoveryDriftProjection>;
  notChecked(reason: string): ReviewDiscoveryDriftProjection;
}
