/**
 * @module audit/iso27001/mapping-schema
 * @description Strict schema for the organization-owned evidence mapping
 * (`iso27001-evidence-mapping.v1`).
 *
 * The mapping is ORGANIZATIONAL input, not FlowGuard authority: it asserts
 * which Annex A or organization-namespaced controls the organization maps, and
 * which minimum FlowGuard evidence the organization's own policy requirement
 * demands. Approval metadata in the mapping is an asserted (unsigned)
 * statement; it is never presented as cryptographic authorization.
 *
 * Rules:
 * - exact edition identity (`ISO/IEC 27001:2022`), Annex A namespace closed
 * - organization controls live in a separate namespace and are never conflated
 *   with Annex A ids
 * - duplicate rule ids and duplicate (control, policy requirement) pairs are
 *   ambiguous and rejected, never resolved by precedence
 * - selectors are a closed vocabulary; no wildcards, no free-form queries
 *
 * @version v1
 */

import { z } from 'zod';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import {
  ANNEX_A_CONTROL_IDS,
  ISO27001_ANNEX_A_NAMESPACE,
  ISO27001_FRAMEWORK_ID,
} from './control-catalog.js';
import { EvidenceSelectorSchema } from './selectors.js';

export const ISO27001_MAPPING_SCHEMA_VERSION = 'iso27001-evidence-mapping.v1' as const;

/** Bounded identifier for organization-owned references. */
const OrganizationIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Annex A control reference — edition and annex are part of the identity. */
export const AnnexAControlRefSchema = z
  .object({
    namespace: z.literal(ISO27001_ANNEX_A_NAMESPACE),
    controlId: z.enum(ANNEX_A_CONTROL_IDS),
  })
  .strict();

/** Organization control reference — a separate namespace, never Annex A. */
export const OrganizationControlRefSchema = z
  .object({
    namespace: z.literal('organization'),
    controlId: z.string().regex(OrganizationIdPattern),
  })
  .strict();

export const ControlRefSchema = z.discriminatedUnion('namespace', [
  AnnexAControlRefSchema,
  OrganizationControlRefSchema,
]);
export type ControlRef = z.infer<typeof ControlRefSchema>;

export const SoaReferenceSchema = z
  .object({
    documentId: z.string().regex(OrganizationIdPattern),
    version: z.string().min(1).max(64),
    /** Optional digest of the organization's SoA document at mapping time. */
    sha256: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    status: z.enum(['current', 'unknown']),
  })
  .strict();
export type SoaReference = z.infer<typeof SoaReferenceSchema>;

export const MappingRuleSchema = z
  .object({
    ruleId: z.string().regex(OrganizationIdPattern),
    controlRef: ControlRefSchema,
    /** Organization-authored policy/requirement identifier. */
    policyRequirementId: z.string().regex(OrganizationIdPattern),
    /**
     * Organizational applicability assertion. v1 NEVER converts this into a
     * verified applicability decision — an asserted exclusion is reported, but
     * the rule can never reach EVIDENCE_LINKED_VERIFIED.
     */
    applicability: z.enum(['asserted_applicable', 'asserted_excluded']),
    evidence: z.array(EvidenceSelectorSchema).min(1).max(20),
  })
  .strict();
export type MappingRule = z.infer<typeof MappingRuleSchema>;

export const Iso27001EvidenceMappingSchema = z
  .object({
    mappingSchemaVersion: z.literal(ISO27001_MAPPING_SCHEMA_VERSION),
    framework: z
      .object({
        id: z.literal(ISO27001_FRAMEWORK_ID),
        annex: z.literal('A'),
      })
      .strict(),
    organizationId: z.string().regex(OrganizationIdPattern),
    ismsScopeId: z.string().regex(OrganizationIdPattern),
    mappingVersion: z.string().min(1).max(64),
    owner: z.string().min(1).max(200),
    approval: z
      .object({
        reference: z.string().min(1).max(200),
        approvedAt: z.string().datetime(),
        assertedBy: z.string().min(1).max(200),
      })
      .strict(),
    soaRef: SoaReferenceSchema.optional(),
    rules: z.array(MappingRuleSchema).min(1).max(200),
  })
  .strict()
  .superRefine((mapping, ctx) => {
    const ruleIds = new Set<string>();
    const controlRequirementPairs = new Set<string>();
    mapping.rules.forEach((rule, index) => {
      if (ruleIds.has(rule.ruleId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index, 'ruleId'],
          message: `Duplicate ruleId '${rule.ruleId}'`,
        });
      }
      ruleIds.add(rule.ruleId);
      const pair = [
        rule.controlRef.namespace,
        rule.controlRef.controlId,
        rule.policyRequirementId,
      ].join('\u0000');
      if (controlRequirementPairs.has(pair)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['rules', index],
          message: `Duplicate control/policy-requirement mapping for '${rule.policyRequirementId}'`,
        });
      }
      controlRequirementPairs.add(pair);
    });
  });
export type Iso27001EvidenceMapping = z.infer<typeof Iso27001EvidenceMappingSchema>;

/** One deterministic validation issue (stable order, no raw input echo). */
export interface MappingValidationIssue {
  readonly path: string;
  readonly message: string;
}

export type MappingParseResult =
  | { readonly ok: true; readonly mapping: Iso27001EvidenceMapping }
  | { readonly ok: false; readonly issues: readonly MappingValidationIssue[] };

/**
 * Parse unknown JSON into a validated mapping. Fail-closed: any schema
 * violation or ambiguity yields issues and NO mapping — there is no partial
 * acceptance and no fallback to a weaker rule.
 */
export function parseIso27001EvidenceMapping(input: unknown): MappingParseResult {
  const parsed = Iso27001EvidenceMappingSchema.safeParse(input);
  if (parsed.success) return { ok: true, mapping: parsed.data };
  return {
    ok: false,
    issues: parsed.error.issues.map((issue) => ({
      path: issue.path.map((segment) => String(segment)).join('.'),
      message: issue.message,
    })),
  };
}

/** Canonical digest of the parsed mapping (authority for report and companions). */
export function mappingDigestOf(mapping: Iso27001EvidenceMapping): string {
  return hashText(canonicalJsonStringify(mapping));
}
