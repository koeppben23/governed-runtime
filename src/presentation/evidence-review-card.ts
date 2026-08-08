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

import type {
  ReviewCardDocument,
  PresentationSection,
  KeyValueItem,
  FindingGroup,
  FindingItem,
  PresentationAction,
} from './model.js';
import { renderMarkdown } from './markdown.js';
import type { PresentationRenderOptions } from './glyph-profile.js';
import type { CompactProofPresentation } from './proof-summary.js';
import { buildProofGraphSection } from './proof-summary.js';
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
  /** Optional compact ProofGraph summary for the review card (post-implementation evaluation). */
  proofSummary: CompactProofPresentation;
  /** Status line describing the review convergence (converged or force-converged). */
  statusLine: string;
  /** True when the review loop force-converged at the iteration limit. */
  forcedConvergence?: boolean;
  /** Accepted advisory risks from the latest independent implementation review. */
  majorRisks?: Array<{ severity: string; category: string; message: string; location?: string }>;
  /** Verification gaps identified by the latest independent implementation review. */
  missingVerification?: string[];
  /** Unresolved questions identified by the latest independent implementation review. */
  unknowns?: string[];
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
  return renderMarkdown(buildEvidenceReviewDocument(input), options);
}

/** Build the typed evidence-review document before Markdown rendering. */
export function buildEvidenceReviewDocument(input: EvidenceReviewCardInput): ReviewCardDocument {
  const sections: PresentationSection[] = [];

  // ── Title ──────────────────────────────────────────────────────────
  sections.push({ kind: 'title', text: 'FlowGuard Implementation Review' });

  // ── Metadata ───────────────────────────────────────────────────────
  const metadata: KeyValueItem[] = [{ label: 'Status', value: input.statusLine }];
  metadata.push({ label: 'Phase', value: input.phaseLabel });
  sections.push({ kind: 'keyValue', items: metadata });

  // ── Force-convergence warning ──────────────────────────────────────
  if (input.forcedConvergence) {
    sections.push({
      kind: 'notice',
      level: 'warning',
      message: 'Reviewer did NOT approve this implementation.',
      additionalMessages: [
        'The independent review reached its iteration limit without convergence. ' +
          'Review the implementation and outstanding findings carefully before approving.',
      ],
      details: [],
    });
  }

  // ── ProofGraph summary (post-evaluation) ────────────────────────────
  sections.push(buildProofGraphSection(input.proofSummary));

  appendAdvisoryFindingsSections(sections, input);

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

  return document;
}

/** Build the completion presentation after an EVIDENCE_REVIEW approval. */
export function buildEvidenceApprovalCompletionDocument(input: {
  proofSummary: CompactProofPresentation;
  exportAction: PresentationAction;
}): ReviewCardDocument {
  return {
    kind: 'review_card',
    form: 'success',
    sections: [buildProofGraphSection(input.proofSummary)],
    conclusion: { kind: 'next_action', action: input.exportAction },
  };
}

function appendAdvisoryFindingsSections(
  sections: PresentationSection[],
  input: Pick<EvidenceReviewCardInput, 'majorRisks' | 'missingVerification' | 'unknowns'>,
): void {
  if (input.majorRisks && input.majorRisks.length > 0) {
    const items: FindingItem[] = input.majorRisks.map((finding) => ({
      category: finding.category,
      message: finding.message,
      ...(finding.location ? { location: finding.location } : {}),
    }));
    const groups: FindingGroup[] = [{ severity: 'major', label: 'Major Risks', items }];
    sections.push({ kind: 'findings', heading: 'Reviewer Findings', groups });
  }
  if (input.missingVerification && input.missingVerification.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: `Missing Verification (${input.missingVerification.length})`,
      items: input.missingVerification,
    });
  }
  if (input.unknowns && input.unknowns.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: `Unknowns (${input.unknowns.length})`,
      items: input.unknowns,
    });
  }
}
