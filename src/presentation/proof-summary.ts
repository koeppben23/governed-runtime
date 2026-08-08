/**
 * @module presentation/proof-summary
 * @description Compact ProofGraph summary types and renderer for review cards.
 *
 * Presentation-only — no state dependency, no side effects, no audit/ imports.
 * Projectors that read SessionState live in integration/proofgraph/proof-summary-projectors.ts.
 *
 * @version v1
 */

import type { ProofGraphSection } from './model.js';
import type {
  ClaimVerificationState,
  CompactProofClaim,
  CompactProofPresentation,
  ProofApprovalPresentation,
} from './proof-model.js';

export type {
  ClaimVerificationState,
  CompactProofClaim,
  CompactProofPresentation,
  ProofApprovalPresentation,
} from './proof-model.js';

// ─── Renderer ───────────────────────────────────────────────────────────────

export function renderCompactProofSection(presentation: CompactProofPresentation): string {
  if (presentation.kind === 'declaration') {
    return renderDeclarationSection(presentation);
  }
  return renderEvaluationSection(presentation);
}

/** Render the canonical ProofGraph heading and semantic content as Markdown. */
export function renderProofGraphMarkdown(presentation: CompactProofPresentation): string {
  return `## ProofGraph\n\n${renderCompactProofSection(presentation)}`;
}

function renderDeclarationSection(p: CompactProofPresentation & { kind: 'declaration' }): string {
  const lines: string[] = [];
  const flowLabel = p.flow === 'plan' ? 'Plan' : 'Architecture';
  if (p.overallStatus === 'NOT_DECLARED') {
    lines.push('Status: NOT_DECLARED');
    lines.push('No proof obligations declared.');
    appendApproval(lines, p.approval);
    return lines.join('\n');
  }
  lines.push(`${p.claimCount} ${flowLabel.toLowerCase()} claim(s) declared`);
  lines.push(`${p.criticalCount} critical`);

  if (p.falsificationReadyCount !== undefined || p.missingFalsificationCount !== undefined) {
    lines.push('');
    if (p.missingFalsificationCount !== undefined && p.missingFalsificationCount > 0) {
      lines.push(
        `⚠ ${p.missingFalsificationCount} critical claim(s) lack a counterexample check — falsification evidence is required for proof.`,
      );
    }
    if (p.falsificationReadyCount !== undefined && p.falsificationReadyCount > 0) {
      lines.push(`✓ ${p.falsificationReadyCount} critical claim(s) with counterexample checks`);
    }
  }

  lines.push('');
  lines.push('Status: AWAITING_EVIDENCE');
  appendApproval(lines, p.approval);
  return lines.join('\n');
}

function renderEvaluationSection(p: CompactProofPresentation & { kind: 'evaluation' }): string {
  const lines: string[] = [];

  if (p.overallStatus === 'NOT_DECLARED') {
    lines.push('Status: NOT_DECLARED');
    lines.push('No proof obligations declared.');
    lines.push('Critical coverage: 0/0 proven');
    lines.push('Evidence freshness: Not verified');
    appendApproval(lines, p.approval);
    lines.push('');
    lines.push('→ Full evidence lineage: `flowguard_status({ proofGraph: true })`');
    return lines.join('\n');
  }
  const prefix =
    p.decisionContext === 'prospective_approval'
      ? 'If submitted for approval now:'
      : 'Current status:';
  const headlineLabel = renderHeadlineLabel(p.headlineStatus);

  if (p.headlineStatus !== 'PROVEN') {
    lines.push('');
    if (p.decisionContext === 'prospective_approval') {
      lines.push(`${prefix} **${headlineLabel}**`);
    } else {
      lines.push(headlineLabel);
    }

    // Gate reason always appears directly after the headline when present,
    // never hidden behind unrelated claim details.
    if (p.primaryReason) {
      lines.push('');
      lines.push(p.primaryReason);
    }

    if (p.unmetCriticalClaims.length > 0) {
      lines.push('');
      lines.push('Unmet critical claims:');
      appendClaims(lines, p.unmetCriticalClaims);
    }
    if (p.otherHighlightedClaims.length > 0) {
      lines.push('');
      lines.push('Other unresolved claims:');
      appendClaims(lines, p.otherHighlightedClaims);
    }
  } else {
    lines.push('All critical claims PROVEN.');
  }

  lines.push('');
  const parts: string[] = [];
  parts.push(`${p.provenCount} PROVEN`);
  if (p.contradictedCount > 0) parts.push(`${p.contradictedCount} CONTRADICTED`);
  if (p.blockedCount > 0) parts.push(`${p.blockedCount} BLOCKED`);
  if (p.staleCount > 0) parts.push(`${p.staleCount} STALE`);
  if (p.unprovenCount > 0) parts.push(`${p.unprovenCount} UNPROVEN`);
  if (p.notVerifiedCount > 0) parts.push(`${p.notVerifiedCount} NOT_VERIFIED`);
  lines.push(parts.join(' · '));
  lines.push(`Critical coverage: ${p.criticalProvenCount}/${p.criticalCount} proven`);

  if (p.revisionDigest) {
    const short = p.revisionDigest.slice(0, 12);
    lines.push(`Revision: \`${short}\``);
  }

  const freshnessLabel: Record<string, string> = {
    CURRENT: 'Current',
    STALE: 'Stale',
    NOT_VERIFIED: 'Not verified',
  };
  lines.push(`Evidence freshness: ${freshnessLabel[p.evidenceFreshness]}`);
  appendApproval(lines, p.approval);

  lines.push('');
  const detailLabel =
    p.headlineStatus !== 'PROVEN'
      ? '→ Inspect the blocking claim and evidence lineage: `flowguard_status({ proofGraph: true })`'
      : '→ Full evidence lineage: `flowguard_status({ proofGraph: true })`';
  lines.push(detailLabel);

  return lines.join('\n');
}

function appendClaims(lines: string[], claims: readonly CompactProofClaim[]): void {
  for (const claim of claims) {
    lines.push(`"${claim.statement}"`);
    if (claim.reason) lines.push(claim.reason);
    for (const step of claim.recovery ?? []) lines.push(step);
  }
}

function appendApproval(lines: string[], approval: ProofApprovalPresentation): void {
  if (approval.attestations.length === 0) {
    lines.push('Approval evidence: Not recorded');
  } else {
    lines.push('Approval evidence:');
    for (const attestation of approval.attestations) {
      const binding = attestation.binding === 'current' ? 'Current' : 'Stale or unbound';
      lines.push(
        `- ${attestation.flow}: ${binding} (certificate \`${attestation.certificateId}\`)`,
      );
    }
  }
  lines.push('Verification effect: None — approval is not verification');
}

function renderHeadlineLabel(status: ClaimVerificationState): string {
  switch (status) {
    case 'CONTRADICTED':
      return 'CONTRADICTED — fresh adversarial evidence falsified at least one critical claim';
    case 'BLOCKED':
      return 'BLOCKED — the evidence gate cannot clear';
    case 'STALE':
      return 'STALE — previously recorded evidence is no longer current';
    case 'UNPROVEN':
      return 'UNPROVEN — available evidence does not establish at least one critical claim';
    case 'NOT_VERIFIED':
      return 'NOT_VERIFIED — required evidence is missing or unavailable';
    case 'PROVEN':
      return 'All critical claims PROVEN';
  }
}

// ─── Canonical ProofGraph Presentation Section ────────────────────────────────

/**
 * Build the canonical proofGraph presentation section for review cards.
 *
 * Every card that displays ProofGraph data MUST use this function instead of
 * calling {@link renderCompactProofSection} + rolling its own text wrapping.
 * The heading semantics (## Proof obligations vs ## ProofGraph) are owned by
 * {@link renderCompactProofSection}; the structural section wrapping is owned
 * here.
 */
export function buildProofGraphSection(presentation: CompactProofPresentation): ProofGraphSection {
  return {
    kind: 'proofGraph',
    proof: presentation,
  };
}
