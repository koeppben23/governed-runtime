/**
 * @module evidence-identity
 * @description Actor identity schemas — DecisionIdentity, ActorInfo, and verification metadata.
 *
 * @version v1
 */

import { z } from 'zod';
import { assuranceSchema } from './evidence-assurance-internal.js';

/**
 * Structured identity for decision attribution (P30/P33/P34).
 * Extends ActorInfo with assurance level for regulated contexts.
 *
 * P34: actorAssurance now uses three-tier model:
 * - best_effort: operator-provided, no third-party verification
 * - claim_validated: schema + expiry validated from local claim file
 * - idp_verified: cryptographic IdP verification (future P35)
 *
 * Backward compat: 'verified' from P33 v0 is coerced to 'claim_validated'.
 */
export const DecisionIdentity = z
  .object({
    actorId: z.string().min(1),
    actorEmail: z.string().nullable(),
    actorDisplayName: z.string().nullable().optional(),
    actorSource: z.enum(['env', 'git', 'claim', 'oidc', 'unknown']),
    actorAssurance: assuranceSchema().default('best_effort'),
  })
  .readonly();
export type DecisionIdentity = z.infer<typeof DecisionIdentity>;

/**
 * Schema version of DecisionIdentity for state imports.
 */
export const DecisionIdentitySchema = DecisionIdentity;

// ─── Actor Verification Metadata ───────────────────────────────────────────────

/**
 * Actor verification metadata for IdP-verified actors (P35a).
 * Provides provenance information about the IdP verification:
 * - Which issuer and audience were verified
 * - Which key was used for signature verification
 * - When the verification occurred
 */
export const ActorVerificationMetaSchema = z
  .object({
    issuer: z.string(),
    audience: z.array(z.string()),
    keyId: z.string(),
    algorithm: z.string(),
    verifiedAt: z.string().datetime(),
  })
  .readonly();
export type ActorVerificationMeta = z.infer<typeof ActorVerificationMetaSchema>;

// ─── ActorInfo ─────────────────────────────────────────────────────────────────

/**
 * Resolved operator identity for audit attribution (P27/P34/P35a).
 *
 * Three-tier assurance model:
 * - best_effort: operator-provided, no third-party verification (env/git/unknown)
 * - claim_validated: schema + expiry validated from local claim file (claim source)
 * - idp_verified: cryptographic IdP verification (oidc source, P35a)
 *
 * P35a adds verificationMeta for idp_verified actors to provide IdP provenance.
 *
 * P34 design doc: docs/actor-assurance-architecture.md
 */
export const ActorInfoSchema = z
  .object({
    id: z.string().min(1),
    email: z.string().nullable(),
    displayName: z.string().nullable().optional(),
    source: z.enum(['env', 'git', 'claim', 'oidc', 'unknown']),
    assurance: assuranceSchema().default('best_effort'),
    verificationMeta: ActorVerificationMetaSchema.optional(),
  })
  .readonly();
export type ActorInfo = z.infer<typeof ActorInfoSchema>;
