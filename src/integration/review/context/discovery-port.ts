/**
 * @module integration/review/discovery-port
 * @description Structural ports for the advisory Discovery context.
 *
 * Both the drift projection and the health projection are owned by the
 * discovery context. review/ must not import a sibling context or the
 * top-level discovery module, so the host/command layer injects a provider;
 * review only consumes the structural results; the health mirror uses only
 * state-level types.
 *
 * @version v1
 */

import type {
  CodeSurfaceStatus,
  DetectedStack,
  VerificationCandidates,
} from '../../../state/discovery-schemas.js';
import type { ImplementationGuidanceProjection } from '../../implementation-guidance.js';

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

/** Advisory health projection as consumed by reviewer prompt construction. */
export type ReviewDiscoveryHealth =
  | {
      readonly kind: 'derived_discovery_health';
      readonly advisory: true;
      readonly source: 'persisted_discovery_result';
      readonly status: 'available';
      readonly completeCollectors: number;
      readonly partialCollectors: number;
      readonly failedCollectors: number;
      readonly failedCollectorNames: string[];
      readonly hasBudgetExhaustion: boolean;
      readonly readFailureCount: number;
      readonly codeSurfaceStatus: CodeSurfaceStatus;
      readonly collectedAt: string | null;
      readonly ageWarning: string | null;
      readonly healthy: boolean;
    }
  | {
      readonly kind: 'derived_discovery_health';
      readonly advisory: true;
      readonly source: 'persisted_discovery_result';
      readonly status: 'unavailable';
      readonly healthy: false;
      readonly reason: 'missing' | 'corrupt' | 'schema_invalid' | 'read_failed';
      readonly recovery: string;
      readonly notVerified: string[];
    };

/** Rendering limits the bounded Discovery context projection honors. */
export interface DiscoveryContextLimits {
  readonly stackItems: number;
  readonly verificationCandidates: number;
  readonly relevantFiles: number;
  readonly surfaces: number;
  readonly modules: number;
  readonly contracts: number;
  readonly riskHotspots: number;
  readonly tests: number;
  readonly warnings: number;
  readonly notVerified: number;
  readonly changedContributors: number;
}

/**
 * Bounded, advisory Discovery context as resolved by the context loader and
 * rendered into reviewer prompts. Owned by the context zone: both the loader
 * inputs and the prompt projection consume this exact shape.
 */
export interface DiscoveryReviewContext {
  readonly health?: ReviewDiscoveryHealth | null;
  readonly drift?: ReviewDiscoveryDriftProjection | null;
  readonly detectedStack?: DetectedStack | null;
  readonly verificationCandidates?: VerificationCandidates;
  readonly implementationGuidance?: Pick<
    ImplementationGuidanceProjection,
    | 'confidence'
    | 'warnings'
    | 'notVerified'
    | 'relevantFiles'
    | 'surfaces'
    | 'modules'
    | 'contracts'
    | 'riskHotspots'
    | 'tests'
  > | null;
  readonly notVerified?: readonly string[];
  readonly limits?: Partial<DiscoveryContextLimits>;
}

/** Injected Discovery context authority used by the review context loader. */
export interface ReviewDiscoveryProvider {
  build(input: {
    readonly workspaceDir: string;
    readonly worktree: string;
    readonly fingerprint: string;
    readonly timeoutMs?: number;
  }): Promise<ReviewDiscoveryDriftProjection>;
  notChecked(reason: string): ReviewDiscoveryDriftProjection;
  extractHealth(discovery: unknown): ReviewDiscoveryHealth;
  unavailableHealth(reason: string): ReviewDiscoveryHealth;
}
