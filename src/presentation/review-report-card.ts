/**
 * @module presentation/review-report-card
 * @description Pure presentation builder for the Review Report Card.
 *
 * Builds a markdown card presenting standalone /review findings with
 * completeness matrix and audit evidence. Called when /review completes
 * (phase REVIEW_COMPLETE).
 *
 * This is a pure function — no state dependency, no side effects.
 * All fields are derived from the ReviewReport and State already available
 * in the tool handler.
 *
 * @version v1
 */

import type { Phase } from '../state/schema.js';

// ─── Card Input ──────────────────────────────────────────────────────────────

export interface ReviewReportCardInput {
  /** Current workflow phase (expected: REVIEW_COMPLETE). */
  phase: Phase;
  /** Human-readable phase label (from PHASE_LABELS). */
  phaseLabel: string;
  /** Derived from report.completeness.overallComplete. */
  overallStatus: 'complete' | 'incomplete';
  /** Review findings from the report. */
  findings: Array<{
    severity: string;
    category: string;
    message: string;
    location?: string;
  }>;
  /** Completeness summary. */
  completeness: {
    overallComplete: boolean;
    fourEyes: boolean;
    summary: string;
  };
  /** Where the review input originated (pr, branch, url, manual_text). */
  inputOrigin?: string;
  /** External references provided with the review. */
  references?: Array<{ ref: string; type: string }>;
  /** Obligation UUID — present when content-aware review was performed. */
  obligationId?: string;
  /** Evidence source: host-orchestrated or agent-submitted-attested. */
  invocationSource?: string;
  /** Subagent session ID from invocation evidence. */
  reviewerSessionId?: string;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const SEVERITY_GROUP: Record<string, { label: string; order: number }> = {
  critical: { label: 'Critical', order: 0 },
  major: { label: 'Major', order: 1 },
  error: { label: 'Issues', order: 2 },
  minor: { label: 'Warnings', order: 3 },
  warning: { label: 'Warnings', order: 3 },
  info: { label: 'Notes', order: 4 },
};

function severityLabel(severity: string): string {
  return SEVERITY_GROUP[severity]?.label ?? severity;
}

function severityOrder(severity: string): number {
  return SEVERITY_GROUP[severity]?.order ?? 99;
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
 * Build a Review Report Card as a markdown string.
 *
 * Sections:
 * 1. Header with status and input origin
 * 2. Findings grouped by severity (critical > major > warnings > notes)
 * 3. Completeness (4-eyes status + summary)
 * 4. Evidence (obligationId, invocation source, reviewer — when present)
 * 5. Recommended follow-up (orientation, no governance commands)
 */
export function buildReviewReportCard(input: ReviewReportCardInput): string {
  const {
    phaseLabel,
    overallStatus,
    findings,
    completeness,
    inputOrigin,
    references,
    obligationId,
    invocationSource,
    reviewerSessionId,
  } = input;

  const lines: string[] = [];

  // ── Header ──────────────────────────────────────────────────────
  lines.push('# FlowGuard Review Report');
  lines.push('');
  lines.push(`> **Status:** ${phaseLabel}`);
  if (inputOrigin) {
    lines.push(`> **Input:** ${inputOrigin}`);
  }
  if (references && references.length > 0) {
    const refList = references.map((r) => `${r.type}: ${r.ref}`).join(', ');
    lines.push(`> **References:** ${refList}`);
  }
  lines.push('');

  // ── Findings ────────────────────────────────────────────────────
  if (findings.length > 0) {
    const grouped = new Map<number, typeof findings>();
    for (const f of findings) {
      const order = severityOrder(f.severity);
      if (!grouped.has(order)) grouped.set(order, []);
      grouped.get(order)!.push(f);
    }
    const sorted = [...grouped.entries()].sort(([a], [b]) => a - b);

    lines.push('---');
    lines.push('');
    lines.push('## Findings');
    lines.push('');

    for (const [, group] of sorted) {
      const first = group[0];
      if (!first) continue;
      const sev = severityLabel(first.severity);
      lines.push(`### ${sev} (${group.length})`);
      lines.push('');
      for (const f of group) {
        const location = f.location ? ` \`${f.location}\`` : '';
        lines.push(`- **${categoryLabel(f.category)}:** ${f.message}${location}`);
      }
      lines.push('');
    }
  } else {
    lines.push('---');
    lines.push('');
    lines.push('## Findings');
    lines.push('');
    lines.push('No issues found.');
    lines.push('');
  }

  // ── Completeness ────────────────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## Completeness');
  lines.push('');
  lines.push(`- **Overall:** ${completeness.overallComplete ? 'Complete' : 'Incomplete'}`);
  lines.push(`- **Four-eyes principle:** ${completeness.fourEyes ? 'Satisfied' : 'Not satisfied'}`);
  lines.push(`- ${completeness.summary}`);
  lines.push('');

  // ── Evidence ────────────────────────────────────────────────────
  const hasEvidence = obligationId || invocationSource || reviewerSessionId;
  if (hasEvidence) {
    lines.push('---');
    lines.push('');
    lines.push('## Evidence');
    lines.push('');
    if (obligationId) lines.push(`- **Obligation:** \`${obligationId}\``);
    if (invocationSource) lines.push(`- **Invocation source:** ${invocationSource}`);
    if (reviewerSessionId) lines.push(`- **Reviewer session:** \`${reviewerSessionId}\``);
    lines.push('');
  }

  // ── Recommended follow-up ───────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## Recommended follow-up');
  lines.push('');
  lines.push('- Address critical and major findings before merging.');
  lines.push('- Add missing verification where listed.');
  lines.push('- Re-run `/review` after changes if needed.');
  lines.push('');

  return lines.join('\n');
}
