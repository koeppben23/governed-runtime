/**
 * @module evidence-primitives
 * @description Foundation enums, scalar types for FlowGuard evidence schemas.
 *              All schemas in this module depend only on Zod and shared identifiers —
 *              no dependencies on other state modules.
 *
 * @version v1
 */

import { z } from 'zod';
import { FINGERPRINT_PATTERN } from '../shared/flowguard-identifiers.js';

export { FINGERPRINT_PATTERN };

// ─── Closed Enums ─────────────────────────────────────────────────────────────

/**
 * Validation check identifier.
 *
 * Open string — profile registry validates at runtime which IDs are valid.
 * This replaces the closed z.enum() to support extensible profiles:
 * - Profiles register their check IDs (e.g., "test_quality", "rollback_safety")
 * - Custom profiles can add any check ID (e.g., "sast_scan", "license_check")
 * - Runtime validation happens at hydrate time (profile registry) and
 *   at validation time (submitted check IDs must be in activeChecks)
 *
 * Known base IDs (from baseline profile): "test_quality", "rollback_safety".
 */
export const CheckId = z.string().min(1);
export type CheckId = z.infer<typeof CheckId>;

/** User review verdict at a User Gate (approve, request changes, or reject). */
export const ReviewVerdict = z.enum(['approve', 'changes_requested', 'reject']);
export type ReviewVerdict = z.infer<typeof ReviewVerdict>;

/** Revision delta between iterations (digest comparison result). */
export const RevisionDelta = z.enum(['none', 'minor', 'major']);
export type RevisionDelta = z.infer<typeof RevisionDelta>;

/**
 * Plan/implementation review loop verdict — emitted by the reviewer subagent.
 *
 * Three values:
 * - `approve`: the artifact is correct; iteration may converge.
 * - `changes_requested`: the artifact needs revision; the reviewer documents
 *   blocking issues. The submitter then revises and resubmits.
 * - `unable_to_review`: the reviewer cannot honestly evaluate due to a
 *   tool-failure condition (plan/impl text empty/malformed, missing required
 *   context references, structured-output schema violation it cannot recover
 *   from, mandate digest mismatch / corrupted mandate). This is NOT an
 *   evasion route for substantive findings — for those, the correct verdict
 *   is `changes_requested`. When emitted, the loop exits BLOCKED (never
 *   converged); recovery is via fresh /plan or /implement submit (resets
 *   iteration to 0).
 *
 * Note: `reject` is intentionally absent here — that is a human-only action
 * at User Gates, captured by `ReviewVerdict` above.
 */
export const LoopVerdict = z.enum(['approve', 'changes_requested', 'unable_to_review']);
export type LoopVerdict = z.infer<typeof LoopVerdict>;

/** Independent review obligation type. */
export const ReviewObligationType = z.enum(['plan', 'implement', 'architecture', 'review']);
export type ReviewObligationType = z.infer<typeof ReviewObligationType>;

/** Strict review obligation state. */
export const ReviewObligationStatus = z.enum(['pending', 'fulfilled', 'consumed', 'blocked']);
export type ReviewObligationStatus = z.infer<typeof ReviewObligationStatus>;

/** Status of an Architecture Decision Record. */
export const AdrStatus = z.enum(['proposed', 'accepted', 'deprecated']);
export type AdrStatus = z.infer<typeof AdrStatus>;

/** Where the content of a ticket or review originated. */
export const InputOriginSchema = z.enum([
  'manual_text',
  'external_reference',
  'mixed',
  'workspace',
  'branch',
  'pr',
  'unknown',
]);
export type InputOrigin = z.infer<typeof InputOriginSchema>;

// ─── External Reference ────────────────────────────────────────────────────────

/**
 * Audit-grade external reference (URL, ticket ID, branch, commit, etc.).
 * Provides full provenance for the source of ticket/review content.
 */
export const ExternalReferenceSchema = z
  .object({
    ref: z.string().min(1),
    type: z.enum(['ticket', 'issue', 'pr', 'branch', 'commit', 'url', 'doc', 'other']).optional(),
    title: z.string().optional(),
    source: z.string().optional(),
    extractedAt: z.string().datetime().optional(),
  })
  .readonly();
export type ExternalReference = z.infer<typeof ExternalReferenceSchema>;

/** How the reviewer was invoked — host-visible Task tool vs SDK vs manual attested. */
export type ReviewInvocationMode = 'host_subagent_task' | 'sdk_session_prompt' | 'manual_attested';
