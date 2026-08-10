/**
 * @module evidence-primitives
 * @description Foundation enums, scalar types for FlowGuard evidence schemas.
 *              All schemas in this module depend only on Zod and evidence identifiers —
 *              no dependencies on other state modules.
 *
 * @version v1
 */

import { z } from 'zod';
import { FINGERPRINT_PATTERN } from './evidence-identifiers.js';

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
 * - `accept`: the INDEPENDENT REVIEWER accepts the artifact; the loop may
 *   converge. This is the reviewer's verdict, NOT user approval — convergence
 *   only advances to the human review gate, where the user decides via
 *   `ReviewVerdict` (`approve` / `changes_requested` / `reject`).
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
 * Note: `approve` and `reject` are intentionally absent here — those are the
 * human user-gate verdicts captured by `ReviewVerdict` above. The reviewer's
 * acceptance is deliberately a distinct token (`accept`) so it can never be
 * mistaken for a user approval.
 */
export const LoopVerdict = z.enum(['accept', 'changes_requested', 'unable_to_review']);
export type LoopVerdict = z.infer<typeof LoopVerdict>;

/** Independent review obligation type. */
export const ReviewObligationType = z.enum(['plan', 'implement', 'architecture', 'review']);
export type ReviewObligationType = z.infer<typeof ReviewObligationType>;

/** Strict review obligation state. */
export const ReviewObligationStatus = z.enum(['pending', 'fulfilled', 'consumed', 'blocked']);
export type ReviewObligationStatus = z.infer<typeof ReviewObligationStatus>;

export const ReviewRepositoryRevisionProvenance = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('available'),
      headSha: z.string().regex(/^[0-9a-f]{40,64}$/i),
      baseSha: z
        .string()
        .regex(/^[0-9a-f]{40,64}$/i)
        .optional(),
    })
    .readonly(),
  z.object({ kind: z.literal('unavailable'), reason: z.string().min(1) }).readonly(),
]);
export type ReviewRepositoryRevisionProvenance = z.infer<typeof ReviewRepositoryRevisionProvenance>;

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

/**
 * How the reviewer was invoked.
 * - `host_subagent_task`: host-visible Task tool (OpenCode, synchronous, strongest).
 * - `sdk_session_prompt`: in-process SDK reviewer session.
 * - `manual_attested`: agent-submitted attested findings (out-of-process hosts, weakest sanctioned).
 * - `native_subagent_attested`: agent-submitted findings corroborated by a FlowGuard-captured
 *   host hook (SubagentStop / PostToolUse fired inside the `flowguard-reviewer` subagent).
 *   Strictly stronger than `manual_attested` (independent host witness of the reviewer subagent),
 *   but NOT equivalent to `host_subagent_task` (FlowGuard is not the deterministic spawner; the
 *   correlation is best-effort, not a synchronous handshake).
 */
export type ReviewInvocationMode =
  'host_subagent_task' | 'sdk_session_prompt' | 'manual_attested' | 'native_subagent_attested';
