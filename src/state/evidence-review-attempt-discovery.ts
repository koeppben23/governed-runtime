/**
 * @module evidence-review-attempt-discovery
 * @description Attempt-bound repository Discovery context schemas.
 *
 * Extracted from evidence-review.ts along the attempt-discovery boundary to
 * keep both modules within the file-size budget. These schemas own the
 * host-owned snapshot every repository review attempt is minted WITH — the
 * snapshot is advisory investigation context and deliberately not part of the
 * frozen review subject or material identity.
 *
 * @version v1
 */

import { z } from 'zod';
import { DetectedStackSchema } from './discovery-schemas.js';

/**
 * Compact host-owned repository Discovery snapshot bound to a review attempt.
 */
export const RepositoryDiscoverySnapshot = z
  .object({
    observedAt: z.string().datetime(),
    /**
     * SHA-256 digest of the persisted DiscoveryResult at session creation
     * time (SessionState.discoveryDigest) — the canonical persisted-Discovery
     * identity. Deliberately NOT the workspace fingerprint.
     */
    discoveryDigest: z.string().nullable(),
    /** Workspace fingerprint used to locate the persisted Discovery basis. */
    workspaceFingerprint: z.string().nullable(),
    health: z
      .object({
        status: z.enum(['available', 'degraded', 'unavailable']),
        healthy: z.boolean(),
        failedCollectorNames: z.array(z.string()),
        hasBudgetExhaustion: z.boolean(),
        ageWarning: z.string().nullable(),
        notVerified: z.array(z.string()),
      })
      .strict(),
    drift: z
      .object({
        status: z.enum(['clean', 'drifted', 'not_assessed', 'unavailable']),
        drifted: z.boolean(),
        changedContributorNames: z.array(z.string()).optional(),
        // Older persisted attempt snapshots used the collector-only name.
        // Preserve their advisory context while projecting the broader model.
        changedCollectorNames: z.array(z.string()).optional(),
        notVerified: z.array(z.string()),
      })
      .strict()
      .transform(({ changedCollectorNames, changedContributorNames, ...drift }) => ({
        ...drift,
        changedContributorNames: changedContributorNames ?? changedCollectorNames ?? [],
      })),
    detectedStack: DetectedStackSchema.nullable(),
    verificationCandidates: z.array(
      z
        .object({
          candidateId: z.string().min(1).optional(),
          kind: z.string().min(1),
          command: z.string().min(1),
          source: z.string(),
          confidence: z.string(),
        })
        .strict(),
    ),
    riskSurfaces: z.array(z.string()),
    warnings: z.array(z.object({ code: z.string(), message: z.string() }).strict()),
    notVerified: z.array(z.string()),
  })
  .strict()
  .readonly();
export type RepositoryDiscoverySnapshot = z.infer<typeof RepositoryDiscoverySnapshot>;

/**
 * Attempt-bound Discovery context. REQUIRED on every review attempt:
 * `repository` whenever an obligation has frozen repository authority — the
 * snapshot is resolved BEFORE the attempt is minted; `not_applicable` when it
 * does not. No
 * `undefined` semantics exist: absence of the field is a schema violation.
 */
export const ReviewAttemptDiscoveryContext = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('repository'),
      snapshot: RepositoryDiscoverySnapshot,
    })
    .strict()
    .readonly(),
  z
    .object({ kind: z.literal('not_applicable') })
    .strict()
    .readonly(),
]);
export type ReviewAttemptDiscoveryContext = z.infer<typeof ReviewAttemptDiscoveryContext>;
