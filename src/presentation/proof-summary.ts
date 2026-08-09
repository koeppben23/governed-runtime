/**
 * @module presentation/proof-summary
 * @description Compact ProofGraph summary types and renderer for review cards.
 *
 * Presentation-only — no state dependency, no side effects, no audit/ imports.
 * Projectors that read SessionState live in integration/proofgraph/proof-summary-projectors.ts.
 *
 * Renders two modes:
 *   human     — summary line, per-claim human vocabulary, evidence requirements
 *   diagnostic — canonical state per claim (claimId, state, scope, binding code, freshness)
 *
 * Claim visibility is controlled separately from renderer detail:
 *   none     — no per-claim list rendered (only summary counts)
 *   selected — only claims whose ids are in selectedClaimIds are listed
 *   all      — all claims in the humanSummary are rendered
 *
 * @version v3
 */

import type { ProofGraphSection } from './model.js';
import type { CompactProofPresentation, ProofApprovalPresentation } from './proof-model.js';
import type { HumanProofSummary } from './claim-human-projection.js';
import { humanVerificationLabel, projectHumanVerificationStatus } from './human-verification.js';
import { UNICODE_GLYPHS } from './glyph-profile.js';

export type ClaimVisibility = 'none' | 'selected' | 'all';

export interface ProofGraphRenderOptions {
  readonly detail?: 'human' | 'diagnostic';
  readonly humanSummary?: HumanProofSummary;
  readonly claimVisibility?: ClaimVisibility;
  readonly selectedClaimIds?: readonly string[];
}

// ─── Public API ──────────────────────────────────────────────────────────────

export function renderCompactProofSection(presentation: CompactProofPresentation): string {
  if (presentation.kind === 'declaration') {
    return renderDeclarationSection(presentation);
  }
  const humanSummary = 'humanSummary' in presentation ? presentation.humanSummary : undefined;
  return renderCompactProofSectionWithOpts(presentation, { humanSummary });
}

export function renderProofGraphMarkdown(
  presentation: CompactProofPresentation,
  opts?: ProofGraphRenderOptions,
): string {
  const detail = opts?.detail ?? 'human';
  const heading = detail === 'diagnostic' ? '## Verification (diagnostic)' : '## Verification';
  return `${heading}\n\n${renderCompactProofSectionWithOpts(presentation, opts)}`;
}

function renderCompactProofSectionWithOpts(
  presentation: CompactProofPresentation,
  opts?: ProofGraphRenderOptions,
): string {
  if (presentation.kind === 'declaration') {
    return renderDeclarationSection(presentation);
  }
  const detail = opts?.detail ?? 'human';
  const summary = opts?.humanSummary ?? presentation.humanSummary;
  if (detail === 'diagnostic') {
    return renderEvaluationDiagnostic(presentation, summary);
  }
  return renderEvaluationHuman(presentation, summary, opts);
}

export function buildProofGraphSection(
  presentation: CompactProofPresentation,
  opts?: ProofGraphRenderOptions,
): ProofGraphSection {
  return {
    kind: 'proofGraph',
    proof: presentation,
    ...(opts?.detail && opts.detail !== 'human' ? { detail: opts.detail } : {}),
    ...(opts?.humanSummary !== undefined ? { humanSummary: opts.humanSummary } : {}),
  };
}

// ─── Declaration rendering (unchanged structure) ──────────────────────────────

function renderDeclarationSection(p: CompactProofPresentation & { kind: 'declaration' }): string {
  const lines: string[] = [];
  const flowLabel = p.flow === 'plan' ? 'Plan' : 'Architecture';
  if (p.overallStatus === 'NOT_DECLARED') {
    lines.push('Status: NOT_DECLARED');
    lines.push('No verification obligations declared.');
    appendApproval(lines, p.approval);
    return lines.join('\n');
  }
  lines.push(`${p.claimCount} ${flowLabel.toLowerCase()} claim(s) declared`);
  lines.push(`${p.criticalCount} critical`);

  if (p.falsificationReadyCount !== undefined || p.missingFalsificationCount !== undefined) {
    lines.push('');
    if (p.missingFalsificationCount !== undefined && p.missingFalsificationCount > 0) {
      lines.push(
        `${UNICODE_GLYPHS.warning} ${p.missingFalsificationCount} critical claim(s) lack a counterexample check — falsification evidence is required for proof.`,
      );
    }
    if (p.falsificationReadyCount !== undefined && p.falsificationReadyCount > 0) {
      lines.push(
        `${UNICODE_GLYPHS.verified} ${p.falsificationReadyCount} critical claim(s) with counterexample checks`,
      );
    }
  }

  lines.push('');
  lines.push('Status: AWAITING_EVIDENCE');
  appendApproval(lines, p.approval);
  return lines.join('\n');
}

// ─── Human evaluation rendering ──────────────────────────────────────────────

function renderEvaluationHuman(
  p: CompactProofPresentation & { kind: 'evaluation' },
  summary?: HumanProofSummary,
  opts?: ProofGraphRenderOptions,
): string {
  if (p.overallStatus === 'NOT_DECLARED') {
    return renderNotDeclaredHuman(p);
  }
  const visibility = opts?.claimVisibility ?? 'all';
  if (summary !== undefined && summary.claims.length > 0) {
    return renderHumanSummary(p, summary, visibility, opts?.selectedClaimIds);
  }
  // Fallback: when no humanSummary is available, render summary counts only
  return renderEvaluationFallback(p, visibility);
}

function renderNotDeclaredHuman(p: CompactProofPresentation & { kind: 'evaluation' }): string {
  const lines: string[] = [];
  lines.push('No verification obligations declared.');
  appendApproval(lines, p.approval);
  lines.push('');
  lines.push('Diagnostic: `flowguard_status({ proofGraph: true })`');
  return lines.join('\n');
}

function renderHumanSummary(
  p: CompactProofPresentation & { kind: 'evaluation' },
  summary: HumanProofSummary,
  visibility: ClaimVisibility,
  selectedClaimIds?: readonly string[],
): string {
  const lines: string[] = [];
  const glyphs = UNICODE_GLYPHS;

  // Summary line
  lines.push(`${summary.verified} of ${summary.total} claims verified`);
  if (summary.criticalTotal > 0) {
    lines.push(`${summary.criticalVerified} of ${summary.criticalTotal} critical claims verified`);
  }

  // Gate primary reason
  const primReason = 'primaryReason' in p ? p.primaryReason : undefined;
  if (primReason) {
    lines.push('');
    lines.push(primReason);
  }

  // Per-claim human projection — filtered by visibility
  const visibleClaims = filterClaims(summary.claims, visibility, selectedClaimIds);
  for (const claim of visibleClaims) {
    lines.push('');
    const glyph = humanGlyph(claim.status, glyphs);
    lines.push(`${glyph} ${claim.statement}`);
    lines.push(`  ${claim.statusLabel}`);
    if (claim.requiredEvidenceLabel) {
      lines.push(`  Required evidence: ${claim.requiredEvidenceLabel}`);
    }
    if (claim.counterexampleRequirementLabel) {
      lines.push(`  ${claim.counterexampleRequirementLabel}`);
    }
    if (claim.status !== 'verified') {
      lines.push(`  Issue: ${claim.explanation}`);
    }
  }

  lines.push('');
  appendApproval(lines, p.approval);
  lines.push('');
  lines.push('Diagnostic: `flowguard_status({ proofGraph: true })`');

  return lines.join('\n');
}

function filterClaims(
  claims: readonly import('./claim-human-projection.js').ClaimHumanProjection[],
  visibility: ClaimVisibility,
  selectedIds?: readonly string[],
): readonly import('./claim-human-projection.js').ClaimHumanProjection[] {
  if (visibility === 'none') return [];
  if (visibility === 'selected' && selectedIds) {
    const idSet = new Set(selectedIds);
    return claims.filter((c) => idSet.has(c.claimId));
  }
  return claims;
}
// ─── Fallback evaluation rendering ──────────────────────────────────────────

function renderEvaluationFallback(
  p: CompactProofPresentation & { kind: 'evaluation' },
  visibility: ClaimVisibility = 'all',
): string {
  const lines: string[] = [];
  const glyphs = UNICODE_GLYPHS;

  const primReason = 'primaryReason' in p ? p.primaryReason : undefined;
  const provenCount = 'provenCount' in p ? p.provenCount : 0;
  const claimCount = p.claimCount;
  const criticalProven = 'criticalProvenCount' in p ? p.criticalProvenCount : 0;
  const criticalCount = p.criticalCount;

  lines.push(`${provenCount} of ${claimCount} claims verified`);

  if (primReason) {
    lines.push('');
    lines.push(primReason);
  }

  if (visibility !== 'none') {
    const unmet = 'unmetCriticalClaims' in p ? p.unmetCriticalClaims : [];
    for (const claim of unmet) {
      const status = projectHumanVerificationStatus(claim.status);
      const glyph = humanGlyph(status, glyphs);
      lines.push('');
      lines.push(`${glyph} ${claim.statement}`);
      lines.push(`  ${humanVerificationLabel(claim.status)}`);
      if (claim.reason) lines.push(`  ${claim.reason}`);
    }

    const other = 'otherHighlightedClaims' in p ? p.otherHighlightedClaims : [];
    for (const claim of other) {
      const status = projectHumanVerificationStatus(claim.status);
      const glyph = humanGlyph(status, glyphs);
      lines.push('');
      lines.push(`${glyph} ${claim.statement}`);
      lines.push(`  ${humanVerificationLabel(claim.status)}`);
      if (claim.reason) lines.push(`  ${claim.reason}`);
    }
  }

  lines.push('');
  lines.push(`Critical coverage: ${criticalProven}/${criticalCount} verified`);
  appendApproval(lines, p.approval);
  lines.push('');
  lines.push('Diagnostic: `flowguard_status({ proofGraph: true })`');

  return lines.join('\n');
}

// ─── Diagnostic evaluation rendering ─────────────────────────────────────────

function renderEvaluationDiagnostic(
  p: CompactProofPresentation & { kind: 'evaluation' },
  summary?: HumanProofSummary,
): string {
  const lines: string[] = [];

  if (p.overallStatus === 'NOT_DECLARED') {
    lines.push('Status: NOT_DECLARED');
    lines.push('No verification obligations declared.');
    appendApproval(lines, p.approval);
    return lines.join('\n');
  }

  // Raw counts
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
    lines.push(`Revision: \`${p.revisionDigest.slice(0, 12)}\``);
  }

  const freshnessLabel: Record<string, string> = {
    CURRENT: 'Current',
    STALE: 'Stale',
    NOT_VERIFIED: 'Not verified',
  };
  lines.push(`Evidence freshness: ${freshnessLabel[p.evidenceFreshness]}`);

  // Per-claim diagnostic when humanSummary available
  if (summary !== undefined) {
    for (const claim of summary.claims) {
      lines.push('');
      lines.push(`Claim \`${claim.claimId}\``);
      lines.push(`  Canonical state: ${claim.diagnostic.canonicalState}`);
      if (claim.diagnostic.claimScope) {
        lines.push(`  Scope: ${claim.diagnostic.claimScope}`);
      }
      if (claim.diagnostic.bindingReason) {
        lines.push(`  Binding diagnostic: ${claim.diagnostic.bindingReason}`);
      }
      if (claim.diagnostic.requiredEvidence) {
        const pos = claim.diagnostic.requiredEvidence.positive;
        const adv = claim.diagnostic.requiredEvidence.adversarial;
        if (pos.length > 0) {
          lines.push(`  Required evidence: ${pos.join(', ')}`);
        }
        if (adv.length > 0) {
          lines.push(`  Adversarial required: ${adv.join(', ')}`);
        }
      }
      if (claim.diagnostic.counterexampleRequirement) {
        const cr = claim.diagnostic.counterexampleRequirement;
        lines.push(`  Counterexample requirement: ${cr.kind}`);
        lines.push(`  Check: ${cr.checkId}`);
        if (cr.kind === 'assertion' || cr.kind === 'legacy_assertion') {
          lines.push(`  Provider: ${cr.assertion.providerId}`);
          lines.push(`  Assertion: ${cr.assertion.localId}`);
        }
        if (cr.kind === 'aggregate_check' && cr.candidateId) {
          lines.push(`  Candidate: ${cr.candidateId}`);
        }
      }
      if (claim.diagnostic.freshness) {
        const f = claim.diagnostic.freshness;
        lines.push(`  Freshness: ${f.boundDigest.slice(0, 12)} (stale: ${String(f.stale)})`);
      }
      lines.push(`  Statement: ${claim.statement}`);
    }
  } else {
    // Fallback: show raw claims from CompactProofClaim
    for (const claim of p.unmetCriticalClaims) {
      lines.push('');
      lines.push(`Claim \`${claim.claimId}\``);
      lines.push(`  Canonical state: ${claim.status}`);
      lines.push(`  Statement: ${claim.statement}`);
      if (claim.reason) lines.push(`  Reason: ${claim.reason}`);
    }
  }

  appendApproval(lines, p.approval);
  lines.push('');
  lines.push('Diagnostic: `flowguard_status({ proofGraph: true })`');

  return lines.join('\n');
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function humanGlyph(
  status: ReturnType<typeof projectHumanVerificationStatus>,
  glyphs: typeof UNICODE_GLYPHS,
): string {
  switch (status) {
    case 'verified':
      return glyphs.verified;
    case 'failed':
      return glyphs.failed;
    case 'needs_recheck':
    case 'blocked':
      return glyphs.warning;
    case 'not_verified':
      return glyphs.notVerified;
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
        `  - ${attestation.flow}: ${binding} (certificate \`${attestation.certificateId}\`)`,
      );
    }
  }
}
