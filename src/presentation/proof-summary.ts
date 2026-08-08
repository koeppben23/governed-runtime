/**
 * @module presentation/proof-summary
 * @description Compact ProofGraph summary types and renderer for review cards.
 *
 * Presentation-only — no state dependency, no side effects, no audit/ imports.
 * Projectors that read SessionState live in integration/proofgraph/proof-summary-projectors.ts.
 *
 * @version v1
 */

import type { PresentationSection } from './model.js';
import { normalizedMarkdown } from './model.js';

// ─── Public types ───────────────────────────────────────────────────────────

export interface CompactProofClaim {
  readonly claimId: string;
  readonly statement: string;
  readonly status: ClaimVerificationState;
  readonly critical: boolean;
  readonly reason?: string;
  readonly recovery?: readonly string[];
}

/** Covers all six evaluation states from the proofgraph evaluator. */
export type ClaimVerificationState =
  'PROVEN' | 'UNPROVEN' | 'CONTRADICTED' | 'STALE' | 'BLOCKED' | 'NOT_VERIFIED';

export type CompactProofPresentation =
  | {
      readonly kind: 'declaration';
      readonly flow: 'plan' | 'architecture';
      readonly claimCount: number;
      readonly criticalCount: number;
      readonly falsificationReadyCount?: number;
      readonly missingFalsificationCount?: number;
    }
  | {
      readonly kind: 'evaluation';
      readonly claimCount: number;
      readonly criticalCount: number;
      readonly provenCount: number;
      readonly contradictedCount: number;
      readonly blockedCount: number;
      readonly staleCount: number;
      readonly unprovenCount: number;
      readonly notVerifiedCount: number;
      readonly coverage: 'NOT_DECLARED' | 'NOT_VERIFIED' | 'PROVEN';
      readonly headlineStatus: ClaimVerificationState;
      /** Primary reason when the gate blocks without a specific claim (e.g. evaluation_unavailable). */
      readonly primaryReason?: string;
      readonly highlightedClaims?: readonly CompactProofClaim[];
      readonly evidenceFreshness?: 'CURRENT' | 'STALE' | 'NOT_VERIFIED';
      readonly revisionDigest?: string;
      /**
       * Whether this evaluation is at the actual gate (`current_gate`), a
       * preview of what would happen at approval (`prospective_approval`),
       * or a completion summary (`completion`).
       */
      readonly decisionContext: 'current_gate' | 'prospective_approval' | 'completion';
    };

// ─── Renderer ───────────────────────────────────────────────────────────────

export function renderCompactProofSection(presentation: CompactProofPresentation): string {
  if (presentation.kind === 'declaration') {
    return renderDeclarationSection(presentation);
  }
  return renderEvaluationSection(presentation);
}

function renderDeclarationSection(p: CompactProofPresentation & { kind: 'declaration' }): string {
  const lines: string[] = [];
  const flowLabel = p.flow === 'plan' ? 'Plan' : 'Architecture';
  lines.push('## Proof obligations');
  lines.push('');
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
  lines.push('Status: AWAITING EVIDENCE');
  return lines.join('\n');
}

function renderEvaluationSection(p: CompactProofPresentation & { kind: 'evaluation' }): string {
  const lines: string[] = [];
  lines.push('## ProofGraph');

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

    if (p.highlightedClaims && p.highlightedClaims.length > 0) {
      lines.push('');
      for (const claim of p.highlightedClaims) {
        lines.push(`"${claim.statement}"`);
        if (claim.reason) lines.push(`${claim.reason}`);
        if (claim.recovery && claim.recovery.length > 0) {
          for (const step of claim.recovery) {
            lines.push(`${step}`);
          }
        }
        lines.push('');
      }
    }
  } else {
    lines.push('');
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

  if (p.revisionDigest) {
    const short = p.revisionDigest.slice(0, 12);
    lines.push(`Revision: \`${short}\``);
  }

  if (p.evidenceFreshness) {
    const freshnessLabel: Record<string, string> = {
      CURRENT: 'Current',
      STALE: 'Stale',
      NOT_VERIFIED: 'Not verified',
    };
    lines.push(`Evidence freshness: ${freshnessLabel[p.evidenceFreshness]}`);
  }

  lines.push('');
  const detailLabel =
    p.headlineStatus !== 'PROVEN'
      ? '→ Inspect the blocking claim and evidence lineage: `flowguard_status({ proofGraph: true })`'
      : '→ Full evidence lineage: `flowguard_status({ proofGraph: true })`';
  lines.push(detailLabel);

  return lines.join('\n');
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
export function buildProofGraphSection(
  presentation: CompactProofPresentation,
): PresentationSection {
  return {
    kind: 'text',
    content: normalizedMarkdown(renderCompactProofSection(presentation)),
  };
}
