/**
 * @module presentation/plan-review-card
 * @description Pure presentation builder for the Plan Review Card.
 *
 * Builds the Plan Review Card as a typed PresentationDocument rendered through
 * the shared Markdown renderer (renderMarkdown). Called only when independent
 * review converges (phase PLAN_REVIEW), never during active plan refinement.
 *
 * This is a pure function — no state dependency, no side effects.
 * The canonical plan body lives in state.plan.current.body and is
 * embedded verbatim via an EmbeddedMarkdownSection.
 *
 * @version v2
 */

import type { Phase } from '../state/schema.js';
import type { ReviewCardDocument, PresentationSection, KeyValueItem } from './model.js';
import { renderMarkdown } from './markdown.js';
import type { PresentationRenderOptions } from './glyph-profile.js';
import type { CompactProofPresentation } from './proof-model.js';
import { buildProofGraphSection } from './proof-summary.js';
import { buildReviewDecisionConclusion } from './review-decision.js';

// ─── Card Input ──────────────────────────────────────────────────────────────

export interface PlanReviewCardInput {
  /** Full plan markdown body (from state.plan.current.body). */
  planText: string;
  /** Current workflow phase (expected: PLAN_REVIEW). */
  phase: Phase;
  /** Human-readable phase label (from PHASE_LABELS). */
  phaseLabel: string;
  /** Product-friendly next action guidance (from buildProductNextAction). */
  productNextAction: {
    text: string;
    commands: readonly string[];
  };
  /** Plan version number (history.length + 1). Omitted when absent. */
  planVersion?: number;
  /** Active policy mode. Omitted when absent. */
  policyMode?: string;
  /** Ticket / task title. Omitted when absent. */
  taskTitle?: string;
  /**
   * True when the independent review loop force-converged at the iteration
   * limit WITHOUT an approving verdict. Renders a prominent warning so the
   * human reviewer does not mistake the gate for a reviewer-approved plan.
   */
  forcedConvergence?: boolean;
  /** Compact ProofGraph summary for the review card (pre-approval declarations). */
  proofSummary: CompactProofPresentation;
  /** Digest of the plan revision currently at the gate. */
  currentPlanDigest?: string;
  /** Digest of the plan revision these findings were bound to. */
  reviewedDigest?: string;
  /** Obligation that produced these findings. */
  reviewedObligationId?: string;
}

// ─── Action Descriptions ───────────────────────────────────────────────────────

const PLAN_ACTION_DESCRIPTIONS: Record<string, string> = {
  '/approve': 'approve the plan if it is complete and acceptable',
  '/request-changes': 'send the plan back for revision',
  '/reject': 'stop this task',
};

// ─── Card Builder ────────────────────────────────────────────────────────────

/**
 * Build a Plan Review Card as a Markdown string via the shared renderer.
 *
 * Sections (all typed, spacing enforced by renderMarkdown):
 * 1. Title (H1)
 * 2. Metadata (status, version, policy, task — only when present)
 * 3. Force-convergence warning notice (only when the reviewer did not approve)
 * 4. The full plan body verbatim (embedded Markdown)
 *
 * The next action is the document conclusion:
 * - decision_required when human review commands are offered
 *   (/approve, /request-changes, /reject)
 * - terminal otherwise (productNextAction.text with no resolvable command)
 */
export function buildPlanReviewCard(
  input: PlanReviewCardInput,
  options?: PresentationRenderOptions,
): string {
  return renderMarkdown(buildPlanReviewDocument(input), options);
}

/** Build the typed plan-review document before Markdown rendering. */
export function buildPlanReviewDocument(input: PlanReviewCardInput): ReviewCardDocument {
  const { planText, phaseLabel, productNextAction, planVersion, policyMode, taskTitle } = input;

  const sections: PresentationSection[] = [];

  // ── Title ──────────────────────────────────────────────────────────
  sections.push({ kind: 'title', text: 'FlowGuard Plan Review' });

  // ── Metadata ───────────────────────────────────────────────────────
  const metadata: KeyValueItem[] = [{ label: 'Status', value: phaseLabel }];
  if (planVersion !== undefined && Number.isInteger(planVersion) && planVersion > 0) {
    metadata.push({ label: 'Plan version', value: `v${planVersion}` });
  }
  if (policyMode) {
    metadata.push({ label: 'Policy', value: policyMode });
  }
  if (taskTitle) {
    metadata.push({ label: 'Task', value: taskTitle });
  }
  sections.push({ kind: 'keyValue', items: metadata });

  // ── Force-convergence warning ──────────────────────────────────────
  // The loop hit its iteration budget without the reviewer approving. Surface
  // this unmistakably — the human gate must be a deliberate decision, never a
  // rubber-stamp of an unreviewed plan.
  if (input.forcedConvergence) {
    sections.push({
      kind: 'notice',
      level: 'warning',
      message: 'Reviewer did NOT approve this plan.',
      additionalMessages: [
        'The independent review reached its iteration limit without reviewer acceptance ' +
          '(last verdict: changes_requested). Review the outstanding findings carefully before approving.',
      ],
      details: [],
    });
  }

  // ── Prior-revision provenance mismatch ─────────────────────────────
  if (
    input.reviewedDigest &&
    input.currentPlanDigest &&
    input.reviewedDigest !== input.currentPlanDigest
  ) {
    sections.push({
      kind: 'notice',
      level: 'warning',
      message: 'These reviewer findings apply to a prior plan revision.',
      additionalMessages: [
        `Reviewed digest: \`${input.reviewedDigest}\``,
        `Current digest:  \`${input.currentPlanDigest}\``,
        'The current revision was submitted after the final independent review ' +
          'and has not itself been independently reviewed.',
      ],
      details: [],
    });
  }

  // ── Review provenance details ─────────────────────────────────────
  if (input.reviewedDigest) {
    const provenance: KeyValueItem[] = [];
    provenance.push({ label: 'Reviewed plan digest', value: `\`${input.reviewedDigest}\`` });
    if (input.reviewedObligationId) {
      provenance.push({
        label: 'Reviewed obligation',
        value: `\`${input.reviewedObligationId}\``,
      });
    }
    sections.push({ kind: 'keyValue', heading: 'Review Provenance', items: provenance });
  }

  // ── Proof obligations (pre-approval) ───────────────────────────────
  sections.push(buildProofGraphSection(input.proofSummary));

  // ── Plan Body (verbatim) ───────────────────────────────────────────
  sections.push({
    kind: 'embeddedMarkdown',
    heading: 'Proposed Plan',
    content: planText,
  });

  const document: ReviewCardDocument = {
    kind: 'review_card',
    form: productNextAction.commands.some((command) =>
      ['/approve', '/request-changes', '/reject'].includes(command),
    )
      ? 'decision'
      : 'terminal',
    sections,
    conclusion: buildReviewDecisionConclusion(productNextAction, PLAN_ACTION_DESCRIPTIONS),
  };

  return document;
}
