/**
 * @module state/evidence-identifiers
 * @description Canonical evidence discriminator constants owned by the state layer.
 *
 * Every value in this module is a persisted evidence/schema discriminator
 * (fingerprint pattern, schema identity, reviewer type literal). They are
 * consumed by state Zod schemas and re-exported outward for runtime code that
 * needs the same canonical string/regex values without duplicating authority.
 *
 * shared/flowguard-identifiers.ts is a compatibility re-export module.
 *
 * @version v1
 */

/** Canonical regex for a 24-hex-char repository fingerprint. */
export const FINGERPRINT_PATTERN = /^[0-9a-f]{24}$/;

/** Schema identifier for the FlowGuard review report artifact. */
export const REVIEW_REPORT_SCHEMA_ID = 'flowguard-review-report.v1' as const;

/** Subagent type identifier for the FlowGuard reviewer subagent. */
export const REVIEWER_SUBAGENT_TYPE = 'flowguard-reviewer';
