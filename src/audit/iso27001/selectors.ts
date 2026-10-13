/**
 * @module audit/iso27001/selectors
 * @description Closed vocabulary of evidence selectors and their pure resolution.
 *
 * A selector names ONE declared minimum evidence requirement and resolves it
 * against the verified archive snapshot. Resolution is pure and deterministic:
 * identical snapshots and selectors produce identical statuses, references and
 * findings. No selector ever reads live mutable state except
 * `export.completion`, whose live binding is reported as such.
 *
 * Reused canonical authorities (no parallel security logic):
 * - `hasCurrentPlanApprovalCertificate` — current plan certificate binding
 * - `planApprovalContextOf` — the only session/policy context bridge
 * - `authorizedCriticalPlanClaimIds` — cert-authorized critical-claim coverage
 * - `classifyValidationDisposition` — supported / artifact_failure / technical_block
 * - `decisionReceipts` (audit/query) — the only decision-receipt derivation
 * - `verifyChain` / `getLastChainHash` — audit chain authority
 *
 * @version v1
 */

import { z } from 'zod';
import { ActorAssuranceSchema } from '../../shared/actor-assurance.js';
import { ProviderId } from '../../state/assertion-identity.js';
import { CheckId, LoopVerdict, ReviewVerdict } from '../../state/evidence-primitives.js';
import { PolicyModeSchema } from '../../state/policy-mode.js';
import { SpecificRiskTrigger } from '../../state/risk-trigger.js';
import type { DecisionReceipt } from '../query.js';
import type { LiveExportBinding, VerifiedEvidenceSnapshot } from './evidence.js';

// ─── Finding Codes ────────────────────────────────────────────────────────────

/**
 * Closed diagnostic vocabulary of the ISO projection.
 *
 * These are report findings, NOT runtime blocked-reason codes: they never gate
 * a workflow and deliberately do not live in the reason registry.
 */
const ISO27001_FINDING_CODES = [
  'PLAN_ABSENT',
  'APPROVAL_CERTIFICATE_MISSING',
  'APPROVAL_CERTIFICATE_NOT_CURRENT',
  'APPROVER_IDENTITY_POLICY_AUTO',
  'APPROVER_IDENTITY_UNRESOLVED',
  'APPROVER_ASSURANCE_BELOW_MINIMUM',
  'IMPLEMENTATION_ABSENT',
  'IMPLEMENTATION_REVIEW_ABSENT',
  'IMPLEMENTATION_REVIEW_WAIVED_BY_POLICY',
  'IMPLEMENTATION_REVISION_STALE',
  'IMPLEMENTATION_DIFF_MEMBER_MISSING',
  'CHECK_ATTEMPT_MISSING',
  'CHECK_FAILED',
  'CHECK_TECHNICAL_BLOCK',
  'ASSERTION_EXTRACTION_NOT_CONFIGURED',
  'ASSERTION_EXTRACTION_BLOCKED',
  'ASSERTION_EXTRACTION_INCONCLUSIVE',
  'ASSERTION_ATTEMPT_MISMATCH',
  'ASSERTION_NOT_REPORTED',
  'ASSERTION_FAILED',
  'ASSERTION_SKIPPED',
  'IMPLEMENTATION_REVIEW_NOT_ACCEPTED',
  'IMPLEMENTATION_REVIEW_FINDINGS_MISSING',
  'IMPLEMENTATION_REVIEW_BINDING_UNVERIFIED',
  'REVIEW_DECISION_MISSING',
  'REVIEW_DECISION_NOT_ACCEPTED',
  'DECISION_RECEIPT_MISSING',
  'DECISION_RECEIPT_MISMATCH',
  'DECISION_RECEIPT_AMBIGUOUS',
  'DECISION_RECEIPT_UNREADABLE',
  'APPROVAL_ACTOR_UNRESOLVED',
  'APPROVAL_ASSURANCE_BELOW_MINIMUM',
  'RISK_ASSESSMENT_NOT_BOUND',
  'RISK_TRIGGER_UNCOVERED',
  'POLICY_MODE_MISMATCH',
  'AUDIT_ANCHOR_MISMATCH',
  'LIVE_STATE_UNAVAILABLE',
  'EXPORT_COMPLETION_EVIDENCE_MISSING',
  'EXPORT_PACKAGE_DIGEST_MISMATCH',
  'APPLICABILITY_ASSERTION_UNVERIFIED',
] as const;
export type Iso27001FindingCode = (typeof ISO27001_FINDING_CODES)[number];
const Iso27001FindingCodeSchema = z.enum(ISO27001_FINDING_CODES);

// ─── Selector Vocabulary ──────────────────────────────────────────────────────

export const EvidenceSelectorSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plan.approved') }).strict(),
  z
    .object({
      kind: z.literal('plan.approver_identity'),
      minActorAssurance: ActorAssuranceSchema,
    })
    .strict(),
  z.object({ kind: z.literal('implementation.revision') }).strict(),
  z
    .object({
      kind: z.literal('validation.check_supported'),
      checkId: CheckId.max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal('validation.assertion_passed'),
      checkId: CheckId.max(200),
      assertion: z
        .object({
          providerId: ProviderId,
          localId: z.string().min(1).max(200),
        })
        .strict(),
    })
    .strict(),
  z
    .object({
      kind: z.literal('review.implementation_verdict'),
      acceptedVerdicts: z.array(LoopVerdict).min(1).max(3),
    })
    .strict(),
  z
    .object({
      kind: z.literal('review.human_approval_decision'),
      gatePhase: z.enum(['PLAN_REVIEW', 'EVIDENCE_REVIEW', 'ARCH_REVIEW']),
      acceptedVerdicts: z.array(ReviewVerdict).min(1).max(4),
      minActorAssurance: ActorAssuranceSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('risk.triggers_covered'),
      triggers: z.array(SpecificRiskTrigger).min(1).max(8),
    })
    .strict(),
  z
    .object({
      kind: z.literal('policy.snapshot'),
      expectedMode: PolicyModeSchema.optional(),
    })
    .strict(),
  z.object({ kind: z.literal('audit.chain_anchor') }).strict(),
  z.object({ kind: z.literal('export.completion') }).strict(),
]);
export type EvidenceSelector = z.infer<typeof EvidenceSelectorSchema>;

// ─── Resolution Vocabulary ────────────────────────────────────────────────────

/** Archive member paths evidence references bind to. */
export const STATE_MEMBER = 'state/session-state.json';
export const AUDIT_MEMBER = 'audit/audit.jsonl';

const SelectorStatusSchema = z.enum([
  'EVIDENCE_LINKED_VERIFIED',
  'EVIDENCE_PRESENT_UNVERIFIED',
  'EVIDENCE_MISSING',
  'NOT_VERIFIED',
]);
export type SelectorStatus = z.infer<typeof SelectorStatusSchema>;

export const SelectorFindingSchema = z
  .object({
    code: Iso27001FindingCodeSchema,
    detail: z.string().max(512).nullable(),
  })
  .strict();
export type SelectorFinding = z.infer<typeof SelectorFindingSchema>;

const EvidenceRefSchema = z
  .object({
    source: z.enum(['state', 'audit', 'manifest', 'live_state', 'live_audit']),
    sessionId: z.string().min(1),
    flowguardSessionId: z.string().nullable(),
    fingerprint: z.string().min(1),
    member: z.string().nullable(),
    memberSha256: z.string().nullable(),
    planVersion: z.number().int().nullable(),
    planDigest: z.string().nullable(),
    implementationId: z.string().nullable(),
    implementationDigest: z.string().nullable(),
    policyHash: z.string().nullable(),
    policyHashVersion: z.string().nullable(),
    checkId: z.string().nullable(),
    attemptId: z.string().nullable(),
    assertionProviderId: z.string().nullable(),
    assertionLocalId: z.string().nullable(),
    actorIdDigest: z.string().nullable(),
    actorSource: z.string().nullable(),
    actorAssurance: z.string().nullable(),
    decisionId: z.string().nullable(),
    exportedPackageSha256: z.string().min(1),
    manifestContentDigest: z.string().min(1),
    occurredAt: z.string().nullable(),
  })
  .strict();
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const SelectorResolutionSchema = z
  .object({
    selector: EvidenceSelectorSchema,
    status: SelectorStatusSchema,
    findings: z.array(SelectorFindingSchema),
    evidence: z.array(EvidenceRefSchema),
  })
  .strict();
export type SelectorResolution = z.infer<typeof SelectorResolutionSchema>;

// ─── Resolution Context ───────────────────────────────────────────────────────

export interface SelectorContext {
  readonly snapshot: VerifiedEvidenceSnapshot;
  /** Live (mutable) workspace binding; only `export.completion` may read it. */
  readonly liveBinding: LiveExportBinding;
  /** Canonical decision receipts derived from the verified audit trail. */
  readonly receipts: readonly DecisionReceipt[];
  /** False when the receipt derivation failed; decision selectors fail closed. */
  readonly receiptsReadable: boolean;
}
