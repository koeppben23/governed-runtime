/**
 * @module audit/iso27001/project
 * @description Deterministic projection from a validated organization mapping
 * and a verified evidence snapshot to `iso27001-evidence-report.v1`.
 *
 * Properties:
 * - pure: no I/O, no clock, no environment — `generatedAt` is an input
 * - deterministic: controls and rules are sorted; selectors stay in declared
 *   order; identical inputs yield an identical `reportDigest`
 * - honest: applicability stays `not_verified`; a rule with an asserted
 *   exclusion can never reach `EVIDENCE_LINKED_VERIFIED`; an unverifiable
 *   selector never upgrades another selector's status
 *
 * @version v1
 */

import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import { decisionReceipts, type DecisionReceipt } from '../query.js';
import {
  ANNEX_A_CONTROL_NAMES,
  ISO27001_2022_ANNEX_A_CONTROLS,
  ISO27001_ANNEX_A_NAMESPACE,
} from './control-catalog.js';
import type { Iso27001EvidenceMapping, MappingRule } from './mapping-schema.js';
import {
  ISO27001_LIMITATION_CODES,
  ISO27001_REPORT_SCHEMA_VERSION,
  Iso27001EvidenceReportSchema,
  type ApplicabilityReport,
  type ControlReport,
  type Iso27001EvidenceReport,
  type RuleReport,
  type RuleStatus,
  type UnresolvedImpact,
} from './report-schema.js';
import { resolveSelector } from './selector-resolve.js';
import type { SelectorContext, SelectorFinding } from './selectors.js';
import type { LiveExportBinding, VerifiedEvidenceSnapshot } from './evidence.js';

export interface Iso27001ProjectionInput {
  readonly mapping: Iso27001EvidenceMapping;
  /** Canonical digest of the validated mapping. */
  readonly mappingDigest: string;
  /**
   * Contents of the verified completion export. The `integrity` brand is only
   * produced by the verified-snapshot reader in production.
   */
  readonly verified: VerifiedEvidenceSnapshot;
  readonly liveBinding: LiveExportBinding;
  readonly generatedAt: string;
}

/**
 * Status precedence for aggregation (rule from selectors, control from rules):
 * a definite failure never hides behind an unknown, and an unknown never
 * hides behind a success. A verified aggregation requires every part verified.
 */
const STATUS_SEVERITY: Readonly<Record<RuleStatus, number>> = {
  EVIDENCE_LINKED_VERIFIED: 0,
  EVIDENCE_PRESENT_UNVERIFIED: 1,
  EVIDENCE_MISSING: 2,
  NOT_VERIFIED: 3,
};

function worstStatus(statuses: readonly RuleStatus[]): RuleStatus {
  let worst: RuleStatus = 'EVIDENCE_LINKED_VERIFIED';
  for (const status of statuses) {
    if (STATUS_SEVERITY[status] > STATUS_SEVERITY[worst]) worst = status;
  }
  return worst;
}

/** Owning-work accounting; the issue requires honest reporting, not silence. */
const UNRESOLVED_IMPACTS: readonly UnresolvedImpact[] = [
  {
    reference: '#1078',
    status: 'resolved_on_baseline',
    impact:
      'Plan approval certificates bind a review-evidence edge and an explicit/policy-auto attestation; this report reads that binding, never a free-form approver string.',
  },
  {
    reference: '#1079',
    status: 'resolved_on_baseline',
    impact:
      'Replan/recovery semantics are owned elsewhere; this projection reads the persisted plan lineage and certificate as they are.',
  },
  {
    reference: '#1080',
    status: 'resolved_on_baseline',
    impact:
      'Ambiguous evidence identities fail closed on the baseline; identity fields here are reported at their recorded assurance and never upgraded.',
  },
  {
    reference: '#959',
    status: 'parked',
    impact:
      'The broader regulated/verification program remains parked; this single-export projection is explicitly not that program.',
  },
];

function controlApplicability(rules: readonly RuleReport[]): ApplicabilityReport {
  const assertions = new Set(rules.map((rule) => rule.applicability.assertion));
  if (assertions.size === 1) {
    const only = [...assertions][0];
    if (only !== undefined) return { assertion: only, verification: 'not_verified' };
  }
  return { assertion: 'not_asserted', verification: 'not_verified' };
}

function resolveRule(rule: MappingRule, context: SelectorContext): RuleReport {
  const selectors = rule.evidence.map((selector) => resolveSelector(selector, context));
  const findings: SelectorFinding[] = [];
  let status = worstStatus(selectors.map((resolution) => resolution.status));

  if (rule.applicability === 'asserted_excluded') {
    // v1 has no verified applicability source: an asserted exclusion is
    // reported, but it can never make the rule verified (D2).
    status = 'NOT_VERIFIED';
    findings.push({
      code: 'APPLICABILITY_ASSERTION_UNVERIFIED',
      detail: 'organization-asserted exclusion has no independently verified applicability source',
    });
  }

  return {
    ruleId: rule.ruleId,
    controlRef: rule.controlRef,
    policyRequirementId: rule.policyRequirementId,
    applicability: { assertion: rule.applicability, verification: 'not_verified' },
    status,
    findings,
    selectors,
  };
}

function buildControlReport(input: {
  readonly controlRef: ControlReport['controlRef'];
  readonly controlName: string | null;
  readonly rules: readonly RuleReport[];
}): ControlReport {
  const { controlRef, controlName, rules } = input;
  return {
    controlRef,
    controlName,
    applicability: controlApplicability(rules),
    status: rules.length === 0 ? 'NOT_MAPPED' : worstStatus(rules.map((rule) => rule.status)),
    rules: [...rules],
  };
}

function organizationControlIds(mapping: Iso27001EvidenceMapping): string[] {
  const ids = new Set<string>();
  for (const rule of mapping.rules) {
    if (rule.controlRef.namespace === 'organization') ids.add(rule.controlRef.controlId);
  }
  return [...ids].sort();
}

/**
 * Project the report. The `reportDigest` covers every semantic field (all
 * fields except `generatedAt` and the digest itself), so two evaluations of
 * identical inputs produce identical digests and identical control/rule
 * results; only `generatedAt` may differ.
 */
function resolvedRulesFor(
  mapping: Iso27001EvidenceMapping,
  namespace: string,
  controlId: string,
  context: SelectorContext,
): RuleReport[] {
  return mapping.rules
    .filter(
      (rule) => rule.controlRef.namespace === namespace && rule.controlRef.controlId === controlId,
    )
    .map((rule) => resolveRule(rule, context))
    .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0));
}

function buildAnnexControls(
  mapping: Iso27001EvidenceMapping,
  context: SelectorContext,
): ControlReport[] {
  return ISO27001_2022_ANNEX_A_CONTROLS.map(({ controlId }) =>
    buildControlReport({
      controlRef: { namespace: ISO27001_ANNEX_A_NAMESPACE, controlId },
      controlName: ANNEX_A_CONTROL_NAMES[controlId],
      rules: resolvedRulesFor(mapping, ISO27001_ANNEX_A_NAMESPACE, controlId, context),
    }),
  );
}

function buildOrganizationControls(
  mapping: Iso27001EvidenceMapping,
  context: SelectorContext,
): ControlReport[] {
  return organizationControlIds(mapping).map((controlId) =>
    buildControlReport({
      controlRef: { namespace: 'organization', controlId },
      controlName: null,
      rules: resolvedRulesFor(mapping, 'organization', controlId, context),
    }),
  );
}

function decisionReceiptContext(verified: VerifiedEvidenceSnapshot): {
  readonly receipts: DecisionReceipt[];
  readonly receiptsReadable: boolean;
} {
  try {
    return { receipts: decisionReceipts([...verified.events]), receiptsReadable: true };
  } catch {
    return { receipts: [], receiptsReadable: false };
  }
}

function buildSemanticReport(input: {
  readonly mapping: Iso27001EvidenceMapping;
  readonly mappingDigest: string;
  readonly verified: VerifiedEvidenceSnapshot;
  readonly controls: ControlReport[];
}): Omit<Iso27001EvidenceReport, 'reportDigest' | 'generatedAt'> {
  const { mapping, mappingDigest, verified, controls } = input;
  return {
    reportSchemaVersion: ISO27001_REPORT_SCHEMA_VERSION,
    framework: {
      id: mapping.framework.id,
      annex: 'A',
      applicabilityAuthority: 'organization_soa_clause_6_1_3',
    },
    organization: {
      organizationId: mapping.organizationId,
      ismsScopeId: mapping.ismsScopeId,
      mappingVersion: mapping.mappingVersion,
      mappingDigest,
    },
    mappingApproval: {
      owner: mapping.owner,
      reference: mapping.approval.reference,
      approvedAt: mapping.approval.approvedAt,
      assertedBy: mapping.approval.assertedBy,
      assurance: 'asserted_unsigned',
    },
    soa: mapping.soaRef ?? null,
    soaVerification: 'not_verified',
    evidencePackage: {
      sessionId: verified.sessionId,
      fingerprint: verified.fingerprint,
      packageSha256: verified.packageSha256,
      sidecarSha256: verified.sidecarSha256,
      manifestContentDigest: verified.manifestContentDigest,
      manifestSchemaVersion: verified.manifestSchemaVersion,
      manifestPolicyMode: verified.manifestPolicyMode,
      auditChainHead: verified.auditChainHead,
      auditEventCount: verified.auditEventCount,
      verification: 'verified_snapshot',
    },
    evaluation: {
      boundary: 'single_completion_export',
      organizationalEffectiveness: 'out_of_scope_independent_assessment',
    },
    controls,
    limitations: [...ISO27001_LIMITATION_CODES],
    unresolvedImpacts: [...UNRESOLVED_IMPACTS],
  };
}

/**
 * Project the report. The `reportDigest` covers every semantic field (all
 * fields except `generatedAt` and the digest itself), so two evaluations of
 * identical inputs produce identical digests and identical control/rule
 * results; only `generatedAt` may differ.
 */
export function projectIso27001Report(input: Iso27001ProjectionInput): Iso27001EvidenceReport {
  const { mapping, mappingDigest, verified, liveBinding, generatedAt } = input;
  const { receipts, receiptsReadable } = decisionReceiptContext(verified);
  const context: SelectorContext = { snapshot: verified, liveBinding, receipts, receiptsReadable };

  const semantic = buildSemanticReport({
    mapping,
    mappingDigest,
    verified,
    controls: [
      ...buildAnnexControls(mapping, context),
      ...buildOrganizationControls(mapping, context),
    ],
  });

  const reportDigest = hashText(canonicalJsonStringify(semantic));
  return Iso27001EvidenceReportSchema.parse({ ...semantic, reportDigest, generatedAt });
}
