/**
 * @module presentation/architecture-review-card
 * @description Pure presentation builder for the Architecture Review Card.
 *
 * Builds a markdown card presenting an Architecture Decision Record (ADR)
 * with reviewer findings, trade-offs, and recommended next actions.
 * Called only when the architecture review converges (ARCH_REVIEW or
 * ARCH_COMPLETE), never during active ADR refinement.
 *
 * This is a pure function — no state dependency, no side effects.
 *
 * @version v1
 */

import type { Phase } from '../state/schema.js';

// ─── Card Input ──────────────────────────────────────────────────────────────

export interface ArchitectureReviewCardInput {
  /** Current workflow phase (ARCH_REVIEW or ARCH_COMPLETE). */
  phase: Phase;
  /** Human-readable phase label (from PHASE_LABELS). */
  phaseLabel: string;
  /** ADR title. */
  adrTitle?: string;
  /** ADR identifier. */
  adrId?: string;
  /** ADR content digest. */
  adrDigest?: string;
  /** Self-review iteration number. */
  iteration: number;
  /** Subagent overall verdict. */
  overallVerdict?: string;
  /** Blocking issues from review findings. */
  blockingIssues?: Array<{
    severity: string;
    category: string;
    message: string;
    location?: string;
  }>;
  /** Major risks from review findings. */
  majorRisks?: Array<{
    severity: string;
    category: string;
    message: string;
    location?: string;
  }>;
  /** Missing verifications. */
  missingVerification?: string[];
  /** Scope creep items. */
  scopeCreep?: string[];
  /** Unknowns. */
  unknowns?: string[];
  /** Product-friendly next action guidance. */
  productNextAction: {
    text: string;
    commands: readonly string[];
  };
  /** True when the ADR has been approved (ARCH_COMPLETE). */
  isApproved: boolean;
}

// ─── Card Builder ────────────────────────────────────────────────────────────

/**
 * Build an Architecture Review Card as a markdown string.
 *
 * Sections:
 * 1. Header with ADR title and status
 * 2. ADR metadata (id, digest, iteration)
 * 3. Reviewer findings (when present)
 * 4. Footer with recommended next actions
 *
 * At ARCH_REVIEW the card shows /approve, /request-changes, /reject.
 * At ARCH_COMPLETE the card shows the approved status without pending actions.
 */
export function buildArchitectureReviewCard(input: ArchitectureReviewCardInput): string {
  const {
    phaseLabel,
    adrTitle,
    adrId,
    iteration,
    overallVerdict,
    blockingIssues,
    majorRisks,
    missingVerification,
    scopeCreep,
    unknowns,
    productNextAction,
    isApproved,
  } = input;

  const lines: string[] = [];
  const verdict = overallVerdict ?? 'pending';

  // ── Header ──────────────────────────────────────────────────────
  lines.push('# FlowGuard Architecture Review');
  lines.push('');
  if (adrTitle) lines.push(`> **ADR:** ${adrTitle}`);
  lines.push(`> **Status:** ${phaseLabel}`);
  lines.push(`> **Verdict:** ${verdict}`);
  lines.push('');

  // ── Metadata ────────────────────────────────────────────────────
  if (adrId || iteration > 0) {
    lines.push('---');
    lines.push('');
    lines.push('## ADR Details');
    lines.push('');
    if (adrId) lines.push(`- **ID:** \`${adrId}\``);
    if (iteration > 0) lines.push(`- **Review iteration:** ${iteration}`);
    lines.push('');
  }

  // ── Reviewer Findings ───────────────────────────────────────────
  const hasFindings =
    (blockingIssues?.length ?? 0) > 0 ||
    (majorRisks?.length ?? 0) > 0 ||
    (missingVerification?.length ?? 0) > 0 ||
    (scopeCreep?.length ?? 0) > 0 ||
    (unknowns?.length ?? 0) > 0;

  if (hasFindings) {
    lines.push('---');
    lines.push('');
    lines.push('## Reviewer Findings');
    lines.push('');

    if (blockingIssues && blockingIssues.length > 0) {
      lines.push(`### Blocking Issues (${blockingIssues.length})`);
      lines.push('');
      for (const f of blockingIssues) {
        const loc = f.location ? ` \`${f.location}\`` : '';
        lines.push(`- **[${f.category}]** ${f.message}${loc}`);
      }
      lines.push('');
    }

    if (majorRisks && majorRisks.length > 0) {
      lines.push(`### Major Risks (${majorRisks.length})`);
      lines.push('');
      for (const f of majorRisks) {
        const loc = f.location ? ` \`${f.location}\`` : '';
        lines.push(`- **[${f.category}]** ${f.message}${loc}`);
      }
      lines.push('');
    }

    if (missingVerification && missingVerification.length > 0) {
      lines.push(`### Missing Verification (${missingVerification.length})`);
      lines.push('');
      for (const m of missingVerification) {
        lines.push(`- ${m}`);
      }
      lines.push('');
    }

    if (scopeCreep && scopeCreep.length > 0) {
      lines.push(`### Scope Creep (${scopeCreep.length})`);
      lines.push('');
      for (const s of scopeCreep) {
        lines.push(`- ${s}`);
      }
      lines.push('');
    }

    if (unknowns && unknowns.length > 0) {
      lines.push(`### Unknowns (${unknowns.length})`);
      lines.push('');
      for (const u of unknowns) {
        lines.push(`- ${u}`);
      }
      lines.push('');
    }
  }

  // ── Footer / Next Actions ───────────────────────────────────────
  lines.push('---');
  lines.push('');
  lines.push('## Next recommended action');
  lines.push('');
  lines.push(productNextAction.text);

  if (!isApproved) {
    const commands = new Set(productNextAction.commands);
    if (commands.size > 0) {
      lines.push('');
      if (commands.has('/approve'))
        lines.push('- `/approve` — approve the ADR if it is complete and acceptable');
      if (commands.has('/request-changes'))
        lines.push('- `/request-changes` — send the ADR back for revision');
      if (commands.has('/reject')) lines.push('- `/reject` — discard this ADR');
    }
  }

  lines.push('');

  return lines.join('\n');
}
