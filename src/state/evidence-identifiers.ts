/**
 * @module state/evidence-identifiers
 * @description Canonical evidence discriminator constants owned by the state layer.
 *
 * Every value in this module is a persisted evidence/schema discriminator
 * (fingerprint pattern, schema identity, policy digest shape). State schemas
 * and direct consumers import these canonical string/regex values here.
 *
 * Non-evidence identifiers remain owned by shared/flowguard-identifiers.ts.
 *
 * @version v1
 */

/** Canonical regex for a 24-hex-char repository fingerprint. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{24}$/;

/** Schema identifier for the FlowGuard review report artifact. */
export const REVIEW_REPORT_SCHEMA_ID = 'flowguard-review-report.v1' as const;

/** Serialization contract for canonical policy snapshot digests. */
export const POLICY_DIGEST_VERSION = 'policy-digest.v3' as const;

/** Canonical lowercase SHA-256 digest shape for policy snapshots. */
export const POLICY_DIGEST_PATTERN = /^[0-9a-f]{64}$/;
