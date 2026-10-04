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
import type { PlanClaimDeclarations } from '../state/proofgraph-approval.js';
import { buildProofGraphSection } from './proof-summary.js';
import { buildReviewDecisionConclusion, type DirectiveProjection } from './review-decision.js';
import { renderPlanClaimDeclarations } from './plan-claim-declarations.js';

// ─── Card Input ──────────────────────────────────────────────────────────────

export interface PlanReviewCardInput {
  /** Full plan markdown body (from state.plan.current.body). */
  planText: string;
  /** Current workflow phase (expected: PLAN_REVIEW). */
  phase: Phase;
  /** Human-readable phase label (from PHASE_LABELS). */
  phaseLabel: string;
  /** Canonical workflow directive projection (code + commands verbatim). */
  directive: DirectiveProjection;
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
  /** Exact claim declarations that the approval certificate will bind. */
  claimDeclarations?: PlanClaimDeclarations;
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
  '/override-approve': 'accept the exhausted plan review with a recorded governance override',
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
 * - terminal otherwise (directive code with no resolvable command)
 */
export function buildPlanReviewCard(
  input: PlanReviewCardInput,
  options?: PresentationRenderOptions,
): string {
  return renderMarkdown(buildPlanReviewDocument(input), options);
}

/** Build the typed plan-review document before Markdown rendering. */
export function buildPlanReviewDocument(input: PlanReviewCardInput): ReviewCardDocument {
  const sections: PresentationSection[] = [
    { kind: 'title', text: 'FlowGuard Plan Review' },
    buildPlanMetadataSection(input),
  ];

  sections.push(...buildPlanWarningNotices(input));

  const provenance = buildPlanProvenanceSection(input);
  if (provenance) sections.push(provenance);

  sections.push(buildProofGraphSection(input.proofSummary));

  const declarations = buildPlanClaimDeclarationsSection(input);
  if (declarations) sections.push(declarations);

  sections.push({
    kind: 'embeddedMarkdown',
    heading: 'Proposed Plan',
    content: input.planText,
  });

  return buildPlanReviewDocumentShell(input, sections);
}

function buildPlanMetadataSection(input: PlanReviewCardInput): PresentationSection {
  const metadata: KeyValueItem[] = [{ label: 'Status', value: input.phaseLabel }];
  const { planVersion } = input;
  if (planVersion !== undefined && Number.isInteger(planVersion) && planVersion > 0) {
    metadata.push({ label: 'Plan version', value: `v${planVersion}` });
  }
  if (input.policyMode) {
    metadata.push({ label: 'Policy', value: input.policyMode });
  }
  if (input.taskTitle) {
    metadata.push({ label: 'Task', value: input.taskTitle });
  }
  return { kind: 'keyValue', items: metadata };
}

/**
 * Warning notices: force-convergence (the loop hit its iteration budget without
 * the reviewer approving) and the prior-revision provenance mismatch. The human
 * gate must be a deliberate decision, never a rubber-stamp of an unreviewed plan.
 * Both notices may apply to the same card and render in this order.
 */
function buildPlanWarningNotices(input: PlanReviewCardInput): PresentationSection[] {
  const notices: PresentationSection[] = [];
  if (input.forcedConvergence) {
    notices.push({
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
  if (
    input.reviewedDigest &&
    input.currentPlanDigest &&
    input.reviewedDigest !== input.currentPlanDigest
  ) {
    notices.push({
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
  return notices;
}

function buildPlanProvenanceSection(input: PlanReviewCardInput): PresentationSection | undefined {
  if (!input.reviewedDigest) return undefined;
  const provenance: KeyValueItem[] = [];
  provenance.push({ label: 'Reviewed plan digest', value: `\`${input.reviewedDigest}\`` });
  if (input.reviewedObligationId) {
    provenance.push({
      label: 'Reviewed obligation',
      value: `\`${input.reviewedObligationId}\``,
    });
  }
  return { kind: 'keyValue', heading: 'Review Provenance', items: provenance };
}

function buildPlanClaimDeclarationsSection(
  input: PlanReviewCardInput,
): PresentationSection | undefined {
  if (!input.claimDeclarations) return undefined;
  return {
    kind: 'embeddedMarkdown',
    heading: 'Claim Declarations Under Approval',
    content: renderPlanClaimDeclarations(input.claimDeclarations),
  };
}

function buildPlanReviewDocumentShell(
  input: PlanReviewCardInput,
  sections: PresentationSection[],
): ReviewCardDocument {
  return {
    kind: 'review_card',
    form: input.directive.kind === 'human_gate' ? 'decision' : 'terminal',
    sections,
    conclusion: buildReviewDecisionConclusion(input.directive, PLAN_ACTION_DESCRIPTIONS),
  };
}
