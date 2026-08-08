/**
 * @module presentation/evidence-review-card
 * @description Pure presentation builder for the Implementation Evidence Review Card.
 *
 * Built when implementation review converges (EVIDENCE_REVIEW phase). Presents
 * the ProofGraph summary, review status, and the human decision gate.
 *
 * Shares the decision conclusion projection with plan-review-card through
 * the canonical review-decision module.
 *
 * @version v1
 */

import type { ReviewCardDocument, PresentationSection } from './model.js';
import { renderMarkdown } from './markdown.js';
import { normalizedMarkdown } from './model.js';
import type { PresentationRenderOptions } from './glyph-profile.js';
import type { CompactProofPresentation } from './proof-summary.js';
import { renderCompactProofSection } from './proof-summary.js';
import { buildReviewDecisionConclusion } from './review-decision.js';

// ─── Card Input ──────────────────────────────────────────────────────────────

export interface EvidenceReviewCardInput {
  /** Human-readable phase label (from PHASE_LABELS). */
  phaseLabel: string;
  /** Canonical product-next-action guidance (from buildProductNextAction). */
  productNextAction: {
    text: string;
    commands: readonly string[];
  };
  /** Compact ProofGraph summary for the review card (post-implementation evaluation). */
  proofSummary: CompactProofPresentation;
  /** Status line describing the review convergence (converged or force-converged). */
  statusLine: string;
  /** True when the review loop force-converged at the iteration limit. */
  forcedConvergence?: boolean;
}

// ─── Action Descriptions ───────────────────────────────────────────────────────

const EVIDENCE_ACTION_DESCRIPTIONS: Record<string, string> = {
  '/approve': 'approve the implementation evidence',
  '/request-changes': 'return to implementation for revision',
  '/reject': 'discard this implementation',
};

// ─── Card Builder ────────────────────────────────────────────────────────────

/**
 * Build the EVIDENCE_REVIEW card as a typed PresentationDocument rendered
 * through the shared Markdown renderer.
 */
export function buildEvidenceReviewCard(
  input: EvidenceReviewCardInput,
  options?: PresentationRenderOptions,
): string {
  const sections: PresentationSection[] = [];

  // ── Header ──────────────────────────────────────────────────────────
  const headerLines: string[] = [];
  headerLines.push('# FlowGuard Implementation Review');
  headerLines.push(`**Status:** ${input.statusLine}`);
  headerLines.push(`**Phase:** ${input.phaseLabel}`);
  if (input.forcedConvergence) {
    headerLines.push(
      '**Warning:** Review loop force-converged at the iteration limit without reviewer approval. Your decision is required.',
    );
  }
  sections.push({ kind: 'text', content: normalizedMarkdown(headerLines.join('\n')) });

  // ── ProofGraph summary (post-evaluation) ────────────────────────────
  if (input.proofSummary) {
    const rendered = renderCompactProofSection(input.proofSummary);
    sections.push({ kind: 'text', content: normalizedMarkdown(rendered) });
  }

  const document: ReviewCardDocument = {
    kind: 'review_card',
    form: input.productNextAction.commands.some((command) =>
      ['/approve', '/request-changes', '/reject'].includes(command),
    )
      ? 'decision'
      : 'terminal',
    sections,
    conclusion: buildReviewDecisionConclusion(
      input.productNextAction,
      EVIDENCE_ACTION_DESCRIPTIONS,
    ),
  };

  return renderMarkdown(document, options);
}
