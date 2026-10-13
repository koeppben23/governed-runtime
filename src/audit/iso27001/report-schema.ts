/**
 * @module audit/iso27001/report-schema
 * @description Deterministic report schema `iso27001-evidence-report.v1`.
 *
 * The report separates three axes and never merges them:
 * (a) applicability asserted by the organization (always `not_verified` in v1),
 * (b) technical evidence integrity/completeness per rule,
 * (c) organizational effectiveness/conformity assessment (out of scope).
 *
 * The vocabulary deliberately contains no `ISO_COMPLIANT`, `CONTROL_SATISFIED`,
 * `CERTIFIED`, `AUDIT_PASSED`, score, or percentage value. A verified
 * association is evidence TOWARD a control, never a conformity conclusion.
 *
 * @version v1
 */

import { z } from 'zod';
import { ISO27001_FRAMEWORK_ID } from './control-catalog.js';
import { ControlRefSchema, SoaReferenceSchema } from './mapping-schema.js';
import { SelectorFindingSchema, SelectorResolutionSchema } from './selectors.js';

export const ISO27001_REPORT_SCHEMA_VERSION = 'iso27001-evidence-report.v1' as const;

/** Per-rule technical evidence status. */
const RuleStatusSchema = z.enum([
  'EVIDENCE_LINKED_VERIFIED',
  'EVIDENCE_PRESENT_UNVERIFIED',
  'EVIDENCE_MISSING',
  'NOT_VERIFIED',
]);
export type RuleStatus = z.infer<typeof RuleStatusSchema>;

/**
 * Per-control aggregate. `NOT_MAPPED` is informational: the control is in the
 * candidate catalog but the organization mapping contains no rule for it.
 */
const ControlStatusSchema = z.enum([
  'EVIDENCE_LINKED_VERIFIED',
  'EVIDENCE_PRESENT_UNVERIFIED',
  'EVIDENCE_MISSING',
  'NOT_VERIFIED',
  'NOT_MAPPED',
]);
export type ControlStatus = z.infer<typeof ControlStatusSchema>;

/**
 * Applicability axis. v1 can only report the organization's asserted value; it
 * never emits a verified applicability decision (`NOT_APPLICABLE_BY_SOA` is
 * deliberately absent from the vocabulary — asserted exclusions stay
 * `not_verified` and can never reach a verified rule status).
 */
const ApplicabilityReportSchema = z
  .object({
    assertion: z.enum(['asserted_applicable', 'asserted_excluded', 'not_asserted']),
    verification: z.literal('not_verified'),
  })
  .strict();
export type ApplicabilityReport = z.infer<typeof ApplicabilityReportSchema>;

const RuleReportSchema = z
  .object({
    ruleId: z.string().min(1).max(64),
    controlRef: ControlRefSchema,
    policyRequirementId: z.string().min(1).max(64),
    applicability: ApplicabilityReportSchema,
    status: RuleStatusSchema,
    /** Rule-level findings (e.g. an asserted exclusion that cannot be verified). */
    findings: z.array(SelectorFindingSchema),
    selectors: z.array(SelectorResolutionSchema).min(1).max(20),
  })
  .strict();
export type RuleReport = z.infer<typeof RuleReportSchema>;

const ControlReportSchema = z
  .object({
    controlRef: ControlRefSchema,
    /** Short catalog name for Annex A controls; null for organization controls. */
    controlName: z.string().min(1).max(120).nullable(),
    applicability: ApplicabilityReportSchema,
    status: ControlStatusSchema,
    rules: z.array(RuleReportSchema),
  })
  .strict();
export type ControlReport = z.infer<typeof ControlReportSchema>;

const EvidencePackageReportSchema = z
  .object({
    sessionId: z.string().min(1),
    fingerprint: z.string().min(1),
    packageSha256: z.string().regex(/^[a-f0-9]{64}$/),
    sidecarSha256: z.string().regex(/^[a-f0-9]{64}$/),
    manifestContentDigest: z.string().min(1),
    manifestSchemaVersion: z.string().min(1),
    manifestPolicyMode: z.string().min(1),
    auditChainHead: z.string().min(1),
    auditEventCount: z.number().int().nonnegative(),
    /** The package that backed this report was verified as a raw snapshot. */
    verification: z.literal('verified_snapshot'),
  })
  .strict();
export type EvidencePackageReport = z.infer<typeof EvidencePackageReportSchema>;

/** Static limitation vocabulary — every report carries all of these. */
export const ISO27001_LIMITATION_CODES = [
  'SOA_CORRECTNESS_NOT_ASSESSED',
  'RISK_TREATMENT_APPROVAL_NOT_ASSESSED',
  'POLICY_ADEQUACY_NOT_ASSESSED',
  'TEST_SEMANTIC_APPROPRIATENESS_NOT_ASSESSED',
  'REVIEWER_INDEPENDENCE_NOT_ENFORCEABLE_HERE',
  'ORGANIZATION_WIDE_DEPLOYMENT_NOT_COVERED',
  'CONTINUOUS_OPERATION_NOT_COVERED',
  'RETENTION_ACCESS_NOT_ASSESSED',
  'EXTERNAL_AUTHENTICITY_NOT_ANCHORED',
  'OPERATIONAL_SECURITY_OUTSIDE_SESSION_NOT_ASSESSED',
  'ISO_27002_IS_IMPLEMENTATION_GUIDANCE_NOT_NORM',
  'SINGLE_COMPLETION_EXPORT_ONLY',
] as const;
const LimitationCodeSchema = z.enum(ISO27001_LIMITATION_CODES);
export type LimitationCode = z.infer<typeof LimitationCodeSchema>;

/** Explicit accounting of the owning work items referenced by the issue. */
const UnresolvedImpactSchema = z
  .object({
    reference: z.string().min(1).max(64),
    status: z.enum(['resolved_on_baseline', 'open', 'parked']),
    impact: z.string().min(1).max(300),
  })
  .strict();
export type UnresolvedImpact = z.infer<typeof UnresolvedImpactSchema>;

const OrganizationReportSchema = z
  .object({
    organizationId: z.string().min(1),
    ismsScopeId: z.string().min(1),
    mappingVersion: z.string().min(1),
    mappingDigest: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

const MappingApprovalReportSchema = z
  .object({
    owner: z.string().min(1).max(200),
    reference: z.string().min(1).max(200),
    approvedAt: z.string().datetime(),
    assertedBy: z.string().min(1).max(200),
    /** The mapping's approval metadata is asserted, never cryptographically proven. */
    assurance: z.literal('asserted_unsigned'),
  })
  .strict();

export const Iso27001EvidenceReportSchema = z
  .object({
    reportSchemaVersion: z.literal(ISO27001_REPORT_SCHEMA_VERSION),
    framework: z
      .object({
        id: z.literal(ISO27001_FRAMEWORK_ID),
        annex: z.literal('A'),
        /** Applicability decisions remain an organizational SoA authority. */
        applicabilityAuthority: z.literal('organization_soa_clause_6_1_3'),
      })
      .strict(),
    organization: OrganizationReportSchema,
    mappingApproval: MappingApprovalReportSchema,
    soa: SoaReferenceSchema.nullable(),
    soaVerification: z.literal('not_verified'),
    evidencePackage: EvidencePackageReportSchema,
    evaluation: z
      .object({
        boundary: z.literal('single_completion_export'),
        organizationalEffectiveness: z.literal('out_of_scope_independent_assessment'),
      })
      .strict(),
    controls: z.array(ControlReportSchema),
    limitations: z.array(LimitationCodeSchema),
    unresolvedImpacts: z.array(UnresolvedImpactSchema),
    /** Canonical digest over everything except `generatedAt` and this field. */
    reportDigest: z.string().regex(/^[a-f0-9]{64}$/),
    generatedAt: z.string().datetime(),
  })
  .strict();
export type Iso27001EvidenceReport = z.infer<typeof Iso27001EvidenceReportSchema>;
