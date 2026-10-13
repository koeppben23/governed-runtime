/**
 * @module audit/iso27001/render-markdown
 * @description Markdown view of `iso27001-evidence-report.v1`.
 *
 * All organization- and evidence-derived strings pass through bounded escaping
 * before they reach the document: control characters are removed, Markdown
 * metacharacters are neutralized, and table cells additionally escape `|`.
 * A mapping or evidence value can therefore never inject document structure,
 * raw HTML, or terminal control sequences into the rendered report.
 *
 * @version v1
 */

import { type Iso27001EvidenceReport, type RuleReport, type RuleStatus } from './report-schema.js';
import { type EvidenceRef, type SelectorResolution } from './selectors.js';

/** Maximum characters of an untrusted value rendered into the document. */
const MAX_VALUE_LENGTH = 200;

/** Remove control characters and bound the value. */
function bounded(value: string): string {
  return (
    value
      // eslint-disable-next-line no-control-regex -- strips terminal control characters from untrusted evidence values
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, MAX_VALUE_LENGTH)
  );
}

/** Escape prose Markdown structure and raw HTML. */
export function escapeMarkdownText(value: string): string {
  return bounded(value)
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/([()*_])/g, '\\$1');
}

/** Escape a table cell: pipes always break cells, even inside code spans. */
export function escapeMarkdownCell(value: string): string {
  return escapeMarkdownText(value).replace(/\|/g, '\\|');
}

/** Render an untrusted value as an escaped inline code span. */
function code(value: string): string {
  return `\`${bounded(value)
    .replace(/`/g, "'")
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)')
    .replace(/\|/g, '\\|')}\``;
}

function renderEvidenceRef(ref: EvidenceRef): string {
  const parts: string[] = [];
  if (ref.member !== null) {
    parts.push(`${ref.member}${ref.memberSha256 !== null ? ` @ ${ref.memberSha256}` : ''}`);
  }
  if (ref.planVersion !== null) parts.push(`plan v${ref.planVersion}`);
  if (ref.implementationDigest !== null) {
    parts.push(`impl ${ref.implementationDigest.slice(0, 16)}`);
  }
  if (ref.attemptId !== null) parts.push(`attempt ${ref.attemptId}`);
  if (ref.actorSource !== null) {
    parts.push(`actor ${ref.actorSource}/${ref.actorAssurance ?? 'unknown'}`);
  }
  if (ref.decisionId !== null) parts.push(`decision ${ref.decisionId}`);
  if (ref.occurredAt !== null) parts.push(ref.occurredAt);
  return escapeMarkdownCell(parts.join('; ') || ref.source);
}

function selectorLabel(selector: SelectorResolution): string {
  const { kind } = selector.selector;
  if (kind === 'validation.assertion_passed') {
    return `${kind} (${code(selector.selector.assertion.localId)})`;
  }
  if ('checkId' in selector.selector) return `${kind} (${code(selector.selector.checkId)})`;
  return kind;
}

function renderSelector(selector: SelectorResolution): string[] {
  const lines: string[] = [];
  lines.push(`- ${selectorLabel(selector)}: **${selector.status}**`);
  for (const finding of selector.findings) {
    lines.push(
      `  - finding: ${code(finding.code)}${finding.detail !== null ? ` — ${escapeMarkdownText(finding.detail)}` : ''}`,
    );
  }
  for (const ref of selector.evidence) {
    lines.push(`  - evidence: ${renderEvidenceRef(ref)}`);
  }
  return lines;
}

function renderRule(rule: RuleReport): string[] {
  const lines: string[] = [];
  lines.push(`#### Rule ${code(rule.ruleId)}`);
  lines.push('');
  lines.push(`- Policy requirement: ${code(rule.policyRequirementId)}`);
  lines.push(`- Applicability: ${rule.applicability.assertion} (verification: not_verified)`);
  lines.push(`- Evidence status: **${rule.status}**`);
  if (rule.findings.length > 0) {
    lines.push(`- Rule findings: ${rule.findings.map((finding) => code(finding.code)).join(', ')}`);
  }
  lines.push('');
  for (const selector of rule.selectors) {
    lines.push(...renderSelector(selector));
  }
  lines.push('');
  return lines;
}

function statusCounts(
  controls: Iso27001EvidenceReport['controls'],
): Readonly<Record<RuleStatus | 'NOT_MAPPED', number>> {
  const counts: Record<string, number> = {
    EVIDENCE_LINKED_VERIFIED: 0,
    EVIDENCE_PRESENT_UNVERIFIED: 0,
    EVIDENCE_MISSING: 0,
    NOT_VERIFIED: 0,
    NOT_MAPPED: 0,
  };
  for (const control of controls) {
    counts[control.status] = (counts[control.status] ?? 0) + 1;
  }
  return counts as Record<RuleStatus | 'NOT_MAPPED', number>;
}

function renderHeader(report: Iso27001EvidenceReport): string[] {
  const lines: string[] = [];
  lines.push('# ISO/IEC 27001:2022 Evidence-to-Control Report');
  lines.push('');
  lines.push(
    '> This report links organization-approved policy requirements to FlowGuard session evidence.',
  );
  lines.push(
    '> It is **not** an ISO/IEC 27001 conformity assessment, not a certification, and not a',
  );
  lines.push('> replacement for the organization ISMS or Statement of Applicability.');
  lines.push('');
  lines.push(`- Organization: ${code(report.organization.organizationId)}`);
  lines.push(`- ISMS scope: ${code(report.organization.ismsScopeId)}`);
  lines.push(
    `- Mapping: version ${code(report.organization.mappingVersion)} (digest ${code(report.organization.mappingDigest)})`,
  );
  lines.push(
    `- Mapping approval: ${code(report.mappingApproval.reference)} by ${code(report.mappingApproval.assertedBy)} (assurance: asserted_unsigned)`,
  );
  lines.push(
    report.soa === null
      ? '- SoA reference: none (applicability is not verified)'
      : `- SoA reference: ${code(report.soa.documentId)} version ${code(report.soa.version)} (verification: not_verified)`,
  );
  lines.push(`- Framework: ${report.framework.id}, Annex ${report.framework.annex}`);
  lines.push(`- Evaluation boundary: ${report.evaluation.boundary}`);
  lines.push('');
  return lines;
}

function renderEvidencePackage(report: Iso27001EvidenceReport): string[] {
  const lines: string[] = [];
  lines.push('## Evidence package');
  lines.push('');
  lines.push(`- Session: ${code(report.evidencePackage.sessionId)}`);
  lines.push(`- Fingerprint: ${code(report.evidencePackage.fingerprint)}`);
  lines.push(`- Package SHA-256: ${code(report.evidencePackage.packageSha256)}`);
  lines.push(`- Sidecar SHA-256: ${code(report.evidencePackage.sidecarSha256)}`);
  lines.push(`- Manifest content digest: ${code(report.evidencePackage.manifestContentDigest)}`);
  lines.push(`- Manifest schema: ${code(report.evidencePackage.manifestSchemaVersion)}`);
  lines.push(`- Policy mode: ${code(report.evidencePackage.manifestPolicyMode)}`);
  lines.push(
    `- Audit chain: ${report.evidencePackage.auditEventCount} event(s), head ${code(report.evidencePackage.auditChainHead)}`,
  );
  lines.push(`- Verification: ${report.evidencePackage.verification}`);
  lines.push(`- Report digest (semantic): ${code(report.reportDigest)}`);
  lines.push(`- Generated: ${code(report.generatedAt)}`);
  lines.push('');
  return lines;
}

function renderControlOverview(report: Iso27001EvidenceReport): string[] {
  const counts = statusCounts(report.controls);
  const lines: string[] = [];
  lines.push('## Control overview');
  lines.push('');
  lines.push(
    `Controls by evidence status: verified=${counts.EVIDENCE_LINKED_VERIFIED}, present_unverified=${counts.EVIDENCE_PRESENT_UNVERIFIED}, missing=${counts.EVIDENCE_MISSING}, not_verified=${counts.NOT_VERIFIED}, not_mapped=${counts.NOT_MAPPED}`,
  );
  lines.push('');
  lines.push('| Control | Name | Applicability | Evidence status | Rules |');
  lines.push('| --- | --- | --- | --- | --- |');
  for (const control of report.controls) {
    lines.push(
      `| ${escapeMarkdownCell(control.controlRef.controlId)} | ${escapeMarkdownCell(control.controlName ?? '(organization control)')} | ${control.applicability.assertion} | ${control.status} | ${control.rules.length} |`,
    );
  }
  lines.push('');
  return lines;
}

function renderRuleDetails(report: Iso27001EvidenceReport): string[] {
  const lines: string[] = [];
  lines.push('## Rule details');
  lines.push('');
  for (const control of report.controls) {
    if (control.rules.length === 0) continue;
    lines.push(
      `### ${control.controlRef.namespace}:${escapeMarkdownCell(control.controlRef.controlId)}`,
    );
    lines.push('');
    for (const rule of control.rules) {
      lines.push(...renderRule(rule));
    }
  }
  return lines;
}

function renderClosing(report: Iso27001EvidenceReport): string[] {
  const lines: string[] = [];
  lines.push('## Limitations (not attested by FlowGuard)');
  lines.push('');
  for (const limitation of report.limitations) {
    lines.push(`- ${limitation}`);
  }
  lines.push('');
  lines.push('## Referenced ownership');
  lines.push('');
  for (const impact of report.unresolvedImpacts) {
    lines.push(
      `- ${code(impact.reference)} (${impact.status}): ${escapeMarkdownText(impact.impact)}`,
    );
  }
  lines.push('');
  return lines;
}

/** Render the report as Markdown. Pure function of the report value. */
export function renderIso27001Markdown(report: Iso27001EvidenceReport): string {
  const lines = [
    ...renderHeader(report),
    ...renderEvidencePackage(report),
    ...renderControlOverview(report),
    ...renderRuleDetails(report),
    ...renderClosing(report),
  ];
  return lines.join('\n');
}
