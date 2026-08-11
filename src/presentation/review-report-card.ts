/**
 * @module presentation/review-report-card
 * @description Pure presentation builder for the Review Report Card.
 *
 * Builds the Review Report Card as a typed PresentationDocument rendered
 * through the shared Markdown renderer (renderMarkdown). Presents standalone
 * /review findings with the completeness matrix and audit evidence. Called
 * when /review completes (phase REVIEW_COMPLETE).
 *
 * This is a pure function — no state dependency, no side effects.
 * All fields are derived from the ReviewReport and State already available
 * in the tool handler.
 *
 * @version v2
 */

import type { Phase } from '../state/schema.js';
import type { ReviewReportFinding } from '../state/evidence.js';
import type { FrozenReviewSubject } from '../state/evidence.js';
import type {
  ReviewCardDocument,
  PresentationSection,
  KeyValueItem,
  FindingGroup,
  FindingItem,
} from './model.js';
import { projectFindingRelation } from './finding-relation.js';
import { renderMarkdown } from './markdown.js';
import type { PresentationRenderOptions } from './glyph-profile.js';
import type { CompactProofPresentation } from './proof-model.js';
import { buildProofGraphSection } from './proof-summary.js';

// ─── Card Input ──────────────────────────────────────────────────────────────

export interface ReviewReportCardInput {
  /** Current workflow phase (expected: REVIEW_COMPLETE). */
  phase: Phase;
  /** Human-readable phase label (from PHASE_LABELS). */
  phaseLabel: string;
  /** Derived from report.completeness.overallComplete. */
  overallStatus: 'clean' | 'warnings' | 'issues';
  /** Review findings from the report. */
  findings: ReviewReportFinding[];
  /** Completeness summary. */
  completeness: {
    overallComplete: boolean;
    fourEyes: boolean;
    summary: string;
    /** Total slots evaluated. 0 means completeness was not assessed for any slots. */
    total: number;
  };
  /** Host-validated immutable identity of the reviewed content. */
  reviewSubject?: FrozenReviewSubject;
  /** Obligation UUID — present when content-aware review was performed. */
  obligationId?: string;
  /** Evidence source: host-orchestrated or agent-submitted-attested. */
  invocationSource?: string;
  /** How the reviewer was invoked: host_subagent_task, sdk_session_prompt, or manual_attested. */
  invocationMode?: string;
  /** Whether this invocation produced a host-visible child session in the OpenCode GUI. */
  hostVisible?: boolean;
  /** Subagent session ID from invocation evidence. */
  reviewerSessionId?: string;
  reviewOutputMode?: string;
  structuredOutputUsed?: boolean;
  reviewAssuranceLevel?: string;
  extractionMethod?: string;
  /** Mandatory state-derived ProofGraph summary. */
  proofSummary: CompactProofPresentation;
  /** Canonical next action resolved from the completed state. */
  productNextAction: { text: string; commands: readonly string[] };
  /** Pre-computed canonical conclusion action (with intent from installed metadata). */
  conclusionAction: import('./model.js').PresentationAction;
}

// ─── Severity / Category Projection ─────────────────────────────────────────────

/**
 * Maps a raw finding severity to a presentation FindingGroup: a display label,
 * a sort order, and a severity from the closed FindingGroup.severity union.
 */
const SEVERITY_GROUP: Record<
  string,
  { label: string; order: number; severity: FindingGroup['severity'] }
> = {
  critical: { label: 'Critical', order: 0, severity: 'critical' },
  major: { label: 'Major', order: 1, severity: 'major' },
  error: { label: 'Issues', order: 2, severity: 'major' },
  minor: { label: 'Warnings', order: 3, severity: 'warning' },
  warning: { label: 'Warnings', order: 3, severity: 'warning' },
  info: { label: 'Notes', order: 4, severity: 'info' },
};

function severityGroup(severity: string): {
  label: string;
  order: number;
  severity: FindingGroup['severity'];
} {
  return SEVERITY_GROUP[severity] ?? { label: severity, order: 99, severity: 'info' };
}

function categoryLabel(category: string): string {
  const map: Record<string, string> = {
    completeness: 'Completeness',
    correctness: 'Correctness',
    feasibility: 'Feasibility',
    risk: 'Risk',
    quality: 'Quality',
    'missing-verification': 'Missing verification',
    'scope-creep': 'Scope creep',
    unknown: 'Unknown',
  };
  return map[category] ?? category;
}

// ─── Card Builder ────────────────────────────────────────────────────────────

/**
 * Build a Review Report Card as a Markdown string via the shared renderer.
 *
 * Sections (all typed, spacing enforced by renderMarkdown):
 * 1. Title (H1)
 * 2. Metadata (status, overall, reviewed subject)
 * 3. Findings grouped by severity (critical > major > issues > warnings > notes)
 * 4. Completeness (4-eyes status + summary)
 * 5. Evidence (obligationId, invocation source, reviewer — when present)
 * 6. Recommended follow-up (orientation, no governance commands)
 *
 * /review is terminal orientation, not a decision gate. It still has a typed
 * terminal conclusion so every visible result has one authoritative closure.
 */
export function buildReviewReportCard(
  input: ReviewReportCardInput,
  options?: PresentationRenderOptions,
): string {
  return renderMarkdown(buildReviewReportDocument(input), options);
}

/** Build the typed standalone-review document before Markdown rendering. */
export function buildReviewReportDocument(input: ReviewReportCardInput): ReviewCardDocument {
  const {
    phaseLabel,
    overallStatus,
    findings,
    completeness,
    reviewSubject,
    obligationId,
    invocationSource,
    invocationMode,
    hostVisible,
    reviewerSessionId,
    reviewOutputMode,
    structuredOutputUsed,
    reviewAssuranceLevel,
    extractionMethod,
    proofSummary,
  } = input;

  const sections: PresentationSection[] = [];

  // ── Title ──────────────────────────────────────────────────────────
  sections.push({ kind: 'title', text: 'FlowGuard Review Report' });

  // ── Metadata ───────────────────────────────────────────────────────
  const metadata: KeyValueItem[] = [
    { label: 'Status', value: phaseLabel },
    { label: 'Overall', value: overallStatus },
  ];
  if (reviewSubject) {
    metadata.push({ label: 'Reviewed subject', value: presentReviewSubject(reviewSubject) });
  }
  sections.push({ kind: 'keyValue', items: metadata });
  sections.push(buildProofGraphSection(proofSummary));

  // ── Findings ───────────────────────────────────────────────────────
  if (findings.length > 0) {
    const grouped = new Map<
      number,
      { label: string; severity: FindingGroup['severity']; items: FindingItem[] }
    >();
    for (const reportFinding of findings) {
      const f = projectReviewReportFinding(reportFinding);
      const g = severityGroup(f.severity);
      let bucket = grouped.get(g.order);
      if (!bucket) {
        bucket = { label: g.label, severity: g.severity, items: [] };
        grouped.set(g.order, bucket);
      }
      bucket.items.push({
        category: categoryLabel(f.category),
        message: f.message,
        ...projectFindingRelation(f.relation),
      });
    }
    const groups: FindingGroup[] = [...grouped.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, bucket]) => ({
        severity: bucket.severity,
        label: bucket.label,
        items: bucket.items,
      }));
    sections.push({ kind: 'findings', heading: 'Findings', detail: 'expanded', groups });
  } else {
    sections.push({
      kind: 'bulletList',
      heading: 'Findings',
      items: ['No issues found.'],
    });
  }

  // ── Completeness ───────────────────────────────────────────────────
  sections.push({
    kind: 'keyValue',
    heading: 'Completeness',
    items: [
      {
        label: 'Overall',
        value:
          completeness.total === 0
            ? 'Not assessed'
            : completeness.overallComplete
              ? 'Complete'
              : 'Incomplete',
      },
      {
        label: 'Four-eyes principle',
        value: completeness.fourEyes ? 'Satisfied' : 'Not satisfied / Not recorded',
      },
      { label: 'Summary', value: completeness.summary },
    ],
  });

  // ── Evidence ───────────────────────────────────────────────────────
  const hasEvidence =
    obligationId ||
    invocationSource ||
    invocationMode ||
    typeof hostVisible === 'boolean' ||
    reviewerSessionId ||
    reviewOutputMode ||
    reviewAssuranceLevel;
  if (hasEvidence) {
    const evidence: KeyValueItem[] = [];
    if (obligationId) evidence.push({ label: 'Obligation', value: `\`${obligationId}\`` });
    if (invocationSource) evidence.push({ label: 'Invocation source', value: invocationSource });
    if (invocationMode) evidence.push({ label: 'Invocation mode', value: invocationMode });
    if (typeof hostVisible === 'boolean') {
      evidence.push({ label: 'Host visible', value: hostVisible ? 'yes' : 'no' });
    }
    if (reviewerSessionId) {
      evidence.push({ label: 'Reviewer session', value: `\`${reviewerSessionId}\`` });
    }
    if (reviewOutputMode) evidence.push({ label: 'Review output mode', value: reviewOutputMode });
    if (typeof structuredOutputUsed === 'boolean') {
      evidence.push({
        label: 'Structured output used',
        value: structuredOutputUsed ? 'yes' : 'no',
      });
    }
    if (reviewAssuranceLevel) {
      evidence.push({ label: 'Review assurance', value: reviewAssuranceLevel });
    }
    if (extractionMethod) evidence.push({ label: 'Extraction method', value: extractionMethod });
    sections.push({ kind: 'keyValue', heading: 'Evidence', items: evidence });
  }

  // ── Recommended follow-up ──────────────────────────────────────────
  const followUp: string[] = [];
  const hasCriticalOrMajor = findings.some(
    (finding) =>
      finding.reportSeverity === 'error' ||
      (finding.source === 'material_finding' &&
        (finding.finding.severity === 'critical' || finding.finding.severity === 'major')),
  );
  if (findings.length === 0) {
    followUp.push(
      'No follow-up required from this review. Re-run `/review` after changes if needed.',
    );
  } else {
    if (hasCriticalOrMajor) {
      followUp.push('Address critical and major findings before merging.');
    }
    followUp.push('Add missing verification where listed.');
    followUp.push('Re-run `/review` after changes if needed.');
  }
  sections.push({ kind: 'bulletList', heading: 'Recommended follow-up', items: followUp });

  const document: ReviewCardDocument = {
    kind: 'review_card',
    form: 'success',
    sections,
    conclusion: {
      kind: 'next_action',
      action: input.conclusionAction,
    },
  };

  return document;
}

/** Project only the frozen, host-validated subject metadata into Markdown-safe text. */
function presentReviewSubject(subject: FrozenReviewSubject): string {
  if (subject.kind === 'repository_change') {
    if (subject.source.kind === 'pull_request') {
      return `Pull request #${subject.source.pullRequestNumber} (${subject.changedPaths.length} changed paths)`;
    }
    return `Branch ${safeMarkdownText(subject.source.branch)} (${subject.changedPaths.length} changed paths)`;
  }
  if (subject.source.kind === 'inline') {
    return `Inline ${subject.source.mediaType} (${subject.lineCount} lines)`;
  }
  const location = subject.source.url.resolved ?? subject.source.url.requested;
  return `URL ${safeMarkdownText(`${location.origin}${location.pathname}`)} (${subject.lineCount} lines)`;
}

function safeMarkdownText(value: string): string {
  return value.replace(/[\\`*_{}\x5b\x5d<>()#+.!|\x2d\n\r]/g, '\\$&');
}

function projectReviewReportFinding(entry: ReviewReportFinding): {
  readonly severity: string;
  readonly category: string;
  readonly message: string;
  readonly relation?: import('./model.js').FindingRelationPresentation;
} {
  switch (entry.source) {
    case 'material_finding':
      return {
        severity: entry.reportSeverity,
        category: entry.finding.category,
        message: entry.finding.message,
        relation: entry.finding.relation,
      };
    case 'mechanical':
    case 'missing_verification':
    case 'scope_creep':
    case 'unknown':
    case 'challenge':
      return {
        severity: entry.reportSeverity,
        category: entry.category,
        message: entry.message,
      };
  }
}
