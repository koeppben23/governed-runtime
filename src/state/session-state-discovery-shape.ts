/**
 * @module session-state-discovery-shape
 * @description SessionState discovery schema group: discovery digest/summary,
 *              detected stack, verification candidates, execution-subject
 *              inputs, and the pre-implementation worktree baseline.
 *
 * @version v1
 */

import { z } from 'zod';
import {
  DetectedStackSchema,
  DiscoverySummarySchema,
  ExecutionSubjectInputSchema,
  VerificationCandidatesSchema,
} from './discovery-schemas.js';

/**
 * Discovery-derived fields of {@link SessionState}.
 * Spread into the canonical SessionState object shape.
 */
export const SessionStateDiscoveryShape = {
  /**
   * SHA-256 digest of the DiscoveryResult at session creation time.
   * Used for drift detection: if the workspace discovery changes,
   * this digest will no longer match the current discovery.json.
   * Null for sessions created before Phase 5 (discovery system).
   */
  discoveryDigest: z.string().nullable().optional(),

  /**
   * Lightweight discovery summary for quick consumption by Plan/Review/Implement.
   * NOT the full DiscoveryResult — just the most useful fields.
   * Null for sessions created before Phase 5 (discovery system).
   */
  discoverySummary: DiscoverySummarySchema.nullable().optional(),

  /**
   * Compact detected stack evidence for surfacing in flowguard_status.
   *
   * Derived evidence — NOT SSOT. The authoritative stack data lives in
   * DiscoveryResult.stack. This is a compact projection of all detected
   * stack items (versioned and unversioned), sorted deterministically
   * by category then id.
   *
   * Null when no items were detected or for pre-discovery sessions.
   */
  detectedStack: DetectedStackSchema.nullable().optional(),

  /**
   * Advisory verification command candidates derived from stack + manifest evidence.
   *
   * Derived evidence — NOT SSOT. These candidates are planning hints only and
   * MUST NOT be treated as executed checks.
   */
  verificationCandidates: VerificationCandidatesSchema.optional(),

  /**
   * Candidate-specific execution-subject inputs keyed by `candidateId`.
   *
   * Produced by the planner alongside `verificationCandidates`. Each entry
   * declares which surfaces (implementation files, config files) must be
   * attested before and after the check runs. A candidate must fail closed
   * when its exact entry is absent; there is no kind-level fallback.
   */
  executionSubjectInputsByCandidateId: z
    .record(z.string(), z.array(ExecutionSubjectInputSchema))
    .optional(),

  /**
   * Pre-implementation worktree baseline (P-baseline): files already dirty
   * at session start (hydrate), used by flowguard_implement to scope recorded
   * evidence to files the task actually changed — pre-existing dirty files
   * (e.g. a stale opencode.json) are subtracted so they are not attributed to
   * the implementation or used to raise the risk floor.
   *
   * `.optional()` for backward compatibility (no schema version bump): when
   * absent, implement does NOT subtract (records the full worktree exactly as
   * before) and surfaces `baselineScoping: "unavailable"` — it never hides
   * evidence. Null is treated identically to absent.
   */
  implementationBaseline: z
    .object({
      /**
       * Files dirty at capture time, each with the git blob hash of its content
       * at session start. A pre-dirty file is scoped out of implementation
       * evidence ONLY if its current hash still matches — so a file the task
       * actually modified (hash changed) is never hidden. `hash` is null for a
       * path that was unreadable/deleted at capture time.
       */
      dirtyFiles: z.array(
        z.object({
          path: z.string(),
          hash: z.string().nullable(),
        }),
      ),
      /** ISO-8601 capture timestamp (hydrate time). */
      capturedAt: z.string().datetime(),
      // #852: git control-plane marker frozen at baseline; optional for legacy baselines.
      controlPlaneMarker: z.string().min(1).optional(),
    })
    .nullable()
    .optional(),
};
