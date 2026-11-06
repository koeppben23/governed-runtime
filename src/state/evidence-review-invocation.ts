/**
 * @module state/evidence-review-invocation
 * @description Independent-review invocation-evidence schema.
 *
 * `ReviewInvocationEvidence` captures host-observed reviewer execution and the
 * structured findings bound to it. The historical OpenCode transport keeps one
 * native Task child across review execution and JSON serialization
 * (`transportVersion: 5`). The current OpenCode V2 transport keeps one native
 * subagent child and additionally proves the terminal capture window
 * (`transportVersion: 6`). The two generations stay explicit and are never
 * normalized into each other. Only generation 6 is bindable; generation 5 is
 * historical evidence kept verifiable for archives.
 *
 * @version v6
 */

import { z } from 'zod';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import { ReviewObligationType } from './evidence-primitives.js';
import { ReviewerModelSelection, ReviewMessageCapture } from './review-message-capture.js';
import { HostMessageId } from './host-identity.js';

const Sha256Digest = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * Host-observed capture facts unique to the native V2 transport. The
 * `capture` record already carries the exact request/response IDs, payload and
 * model; this record proves the terminal window and primary model request that
 * produced it. It is attestation, not a second findings authority.
 */
export const NativeSubagentCaptureProvenance = z
  .object({
    schemaVersion: z.literal(1),
    /** Canonical native call identity under which the dispatch was authorized. */
    nativeCallId: z.string().min(1),
    requestMessageId: HostMessageId,
    responseMessageId: HostMessageId,
    requestDigest: Sha256Digest,
    payloadDigest: Sha256Digest,
    model: ReviewerModelSelection,
    assistantMessageIds: z.tuple([HostMessageId]).readonly(),
    terminal: z
      .object({
        outcome: z.literal('succeeded'),
        finish: z.literal('stop'),
        completedAt: z.string().datetime(),
      })
      .strict()
      .readonly(),
    /** Exactly one primary model request with the same effective selection. */
    modelRequest: z
      .object({
        kind: z.literal('primary'),
        model: ReviewerModelSelection,
      })
      .strict()
      .readonly(),
    historyDigest: Sha256Digest,
    userMessageCount: z.literal(1),
    toolAttemptCount: z.literal(0),
  })
  .strict()
  .readonly();
export type NativeSubagentCaptureProvenance = z.infer<typeof NativeSubagentCaptureProvenance>;

const ReviewInvocationEvidenceShape = z
  .object({
    invocationId: z.string().uuid(),
    obligationId: z.string().uuid(),
    obligationType: ReviewObligationType,
    parentSessionId: z.string().min(1),
    childSessionId: z.string().min(1),
    agentType: z.literal(REVIEWER_SUBAGENT_TYPE),
    /** Persisted host-authoritative attempt identity. */
    attemptId: z.string().uuid(),
    /**
     * `native_task_message_json` is the historical Task transport;
     * `native_subagent_message_json` is the current V2 native subagent
     * transport. Mode and transport version must agree.
     */
    invocationMode: z.enum(['native_task_message_json', 'native_subagent_message_json']),
    transportVersion: z.union([z.literal(5), z.literal(6)]),
    capture: ReviewMessageCapture,
    /** REQUIRED for v6, forbidden for v5. */
    nativeProvenance: NativeSubagentCaptureProvenance.optional(),
    /** Native reviewer execution must be visible from the parent host session. */
    hostVisible: z.literal(true),
    /** Native execution metadata must provide a navigable child transcript. */
    transcriptNavigable: z.literal(true),
    promptHash: z.string().min(1),
    canonicalPromptDigest: Sha256Digest.optional(),
    modelPromptDigest: Sha256Digest.nullable().optional(),
    mandateDigest: z.string().min(1),
    criteriaVersion: z.string().min(1),
    findingsHash: z.string().min(1),
    invokedAt: z.string().datetime(),
    fulfilledAt: z.string().datetime().nullable(),
    consumedByObligationId: z.string().uuid().nullable(),
    /** Verdict derived from the host-captured structured findings. */
    capturedVerdict: z.string().optional(),
    /** Complete structured findings captured by the host from the reviewer's output. */
    capturedRawFindings: z.record(z.string(), z.unknown()),
    /** Evidence is always host-orchestrated. */
    source: z.literal('host-orchestrated'),
    /** Findings are always host-observed structured model output. */
    reviewOutputMode: z.literal('validated_json'),
    /** Message provenance and local validation are distinct from host StructuredOutput. */
    reviewAssuranceLevel: z.literal('host_message_validated'),
    /** Resolved full head commit SHA (branch reviews only). */
    resolvedBranchSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable()
      .optional(),
    /** Resolved full base commit SHA (branch reviews only). */
    resolvedBaseSha: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/i)
      .nullable()
      .optional(),
    /** SHA-256 digest of the extracted/reviewed content (branch reviews only). */
    reviewedContentDigest: z
      .string()
      .regex(/^[0-9a-f]{64}$/i)
      .nullable()
      .optional(),
  })
  .strict();

export const ReviewInvocationEvidence =
  ReviewInvocationEvidenceShape.superRefine(refineInvocationTransport).readonly();

function provenanceMatchesCapture(
  provenance: NativeSubagentCaptureProvenance,
  capture: ReviewMessageCapture,
): boolean {
  return (
    provenance.requestMessageId === capture.requestMessageId &&
    provenance.responseMessageId === capture.responseMessageId &&
    provenance.requestDigest === capture.requestDigest &&
    provenance.payloadDigest === capture.payloadDigest &&
    provenance.assistantMessageIds[0] === capture.assistantMessageIds[0] &&
    provenance.model.providerID === capture.model.providerID &&
    provenance.model.modelID === capture.model.modelID &&
    provenance.model.variant === capture.model.variant &&
    provenance.modelRequest.model.providerID === capture.model.providerID &&
    provenance.modelRequest.model.modelID === capture.model.modelID &&
    provenance.modelRequest.model.variant === capture.model.variant
  );
}

function transportGenerationIssue(value: {
  readonly transportVersion: 5 | 6;
  readonly invocationMode: string;
  readonly nativeProvenance?: NativeSubagentCaptureProvenance | undefined;
}): string | null {
  if (value.transportVersion === 5)
    return value.invocationMode === 'native_task_message_json' &&
      value.nativeProvenance === undefined
      ? null
      : 'transportVersion 5 requires native_task_message_json without V2 provenance.';
  return value.invocationMode === 'native_subagent_message_json' &&
    value.nativeProvenance !== undefined
    ? null
    : 'transportVersion 6 requires native_subagent_message_json with V2 provenance.';
}

function refineInvocationTransport(
  value: z.infer<typeof ReviewInvocationEvidenceShape>,
  ctx: z.RefinementCtx,
): void {
  const issue = transportGenerationIssue(value);
  if (issue !== null) {
    ctx.addIssue({ code: 'custom', message: issue });
    return;
  }
  if (
    value.nativeProvenance !== undefined &&
    !provenanceMatchesCapture(value.nativeProvenance, value.capture)
  )
    ctx.addIssue({
      code: 'custom',
      message: 'V2 capture provenance does not match the captured request/response/model.',
    });
}

export type ReviewInvocationEvidence = z.infer<typeof ReviewInvocationEvidence>;

/**
 * Historical generation-5 transport (V1 native Task + same-child JSON). It stays
 * schema-valid so archived evidence remains verifiable with its original
 * semantics, but it is never bindable, never created and never reinterpreted
 * as generation 6 (operator decision 2026-11-02, #1190).
 */
export function isHistoricalReviewTransport(invocation: {
  readonly invocationMode?: string | undefined;
  readonly transportVersion?: number | undefined;
  readonly nativeProvenance?: unknown;
}): boolean {
  return (
    invocation.transportVersion === 5 &&
    invocation.invocationMode === 'native_task_message_json' &&
    invocation.nativeProvenance === undefined
  );
}

/**
 * Canonical binding predicate: only the current generation-6 native subagent
 * transport with its terminal-capture provenance may fulfil, consume, approve
 * or re-arm review authority.
 */
export function isBindableReviewTransport(invocation: {
  readonly invocationMode?: string | undefined;
  readonly transportVersion?: number | undefined;
  readonly nativeProvenance?: unknown;
}): boolean {
  return (
    invocation.transportVersion === 6 &&
    invocation.invocationMode === 'native_subagent_message_json' &&
    invocation.nativeProvenance !== undefined
  );
}

/** Schema-shape predicate: a canonical generation, historical or current. */
export function isRecognizedReviewTransport(invocation: {
  readonly invocationMode?: string | undefined;
  readonly transportVersion?: number | undefined;
  readonly nativeProvenance?: unknown;
}): boolean {
  return isHistoricalReviewTransport(invocation) || isBindableReviewTransport(invocation);
}
