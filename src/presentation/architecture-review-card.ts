/**
 * @module presentation/architecture-review-card
 * @description Pure presentation builder for the Architecture Review Card.
 *
 * Builds the Architecture Review Card as a typed PresentationDocument rendered
 * through the shared Markdown renderer (renderMarkdown). Presents an
 * Architecture Decision Record (ADR) with reviewer findings, trade-offs, and
 * the recommended next action. Called only when the architecture review
 * converges (ARCH_REVIEW or ARCH_COMPLETE), never during active ADR refinement.
 *
 * This is a pure function — no state dependency, no side effects.
 *
 * @version v2
 */

import type { Phase } from '../state/schema.js';
import type {
  ReviewCardDocument,
  PresentationSection,
  PresentationConclusion,
  PresentationAction,
  KeyValueItem,
  FindingGroup,
  FindingItem,
} from './model.js';
import { renderMarkdown } from './markdown.js';
import { normalizedMarkdown } from './model.js';
import type { PresentationRenderOptions } from './glyph-profile.js';
import type { CompactProofPresentation } from './proof-summary.js';
import { renderCompactProofSection } from './proof-summary.js';

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
  /** Full ADR body in MADR Markdown. Rendered verbatim like the plan card renders planText. */
  adrText?: string;
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
  /**
   * True when the independent review loop force-converged at the iteration
   * limit WITHOUT an approving verdict. Renders a prominent warning so the
   * human reviewer does not mistake the gate for a reviewer-approved ADR.
   */
  forcedConvergence?: boolean;
  /** Compact ProofGraph summary for the review card (decision claims). */
  proofSummary?: CompactProofPresentation;
}

// ─── Action Descriptions ───────────────────────────────────────────────────────

const ADR_ACTION_DESCRIPTIONS: Record<string, string> = {
  '/approve': 'approve the ADR if it is complete and acceptable',
  '/request-changes': 'send the ADR back for revision',
  '/reject': 'discard this ADR',
};

// ─── Card Builder ────────────────────────────────────────────────────────────

/**
 * Build an Architecture Review Card as a Markdown string via the shared renderer.
 *
 * Sections (all typed, spacing enforced by renderMarkdown):
 * 1. Title (H1)
 * 2. Metadata (ADR title, status, verdict)
 * 3. Force-convergence warning notice (only when the reviewer did not approve)
 * 4. ADR details (id, digest, iteration)
 * 5. ADR body verbatim (embedded Markdown, when present)
 * 6. Reviewer findings — blocking issues + major risks as a findings section,
 *    missing verification / scope creep / unknowns as bullet lists
 *
 * The next action is the document conclusion:
 * - decision_required when human review commands are offered (ARCH_REVIEW)
 * - terminal otherwise (ARCH_COMPLETE / no resolvable command)
 */
export function buildArchitectureReviewCard(
  input: ArchitectureReviewCardInput,
  options?: PresentationRenderOptions,
): string {
  const {
    phaseLabel,
    adrTitle,
    adrId,
    adrDigest,
    adrText,
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

  const sections: PresentationSection[] = [];
  const verdict = overallVerdict ?? 'pending';

  // ── Title ──────────────────────────────────────────────────────────
  sections.push({ kind: 'title', text: 'FlowGuard Architecture Review' });

  // ── Metadata ───────────────────────────────────────────────────────
  const metadata: KeyValueItem[] = [];
  if (adrTitle) metadata.push({ label: 'ADR', value: adrTitle });
  metadata.push({ label: 'Status', value: phaseLabel });
  metadata.push({ label: 'Verdict', value: verdict });
  sections.push({ kind: 'keyValue', items: metadata });

  // ── Force-convergence warning ──────────────────────────────────────
  if (input.forcedConvergence && !isApproved) {
    sections.push({
      kind: 'notice',
      level: 'warning',
      message: 'Reviewer did NOT approve this ADR.',
      additionalMessages: [
        'The independent review reached its iteration limit without convergence ' +
          '(last verdict: changes_requested). Review the outstanding findings carefully before approving.',
      ],
      details: [],
    });
  }

  // ── Decision claims (advisory) ──────────────────────────────────────
  if (input.proofSummary) {
    const rendered = renderCompactProofSection(input.proofSummary);
    sections.push({ kind: 'text', content: normalizedMarkdown(rendered) });
  }

  // ── ADR Details ────────────────────────────────────────────────────
  if (adrId || adrDigest || iteration > 0) {
    const details: KeyValueItem[] = [];
    if (adrId) details.push({ label: 'ID', value: `\`${adrId}\`` });
    if (adrDigest) details.push({ label: 'Digest', value: `\`${adrDigest}\`` });
    if (iteration > 0) details.push({ label: 'Review iteration', value: String(iteration) });
    sections.push({ kind: 'keyValue', heading: 'ADR Details', items: details });
  }

  // ── ADR Body (verbatim) ────────────────────────────────────────────
  const normalizedAdrText = adrText?.trim();
  if (normalizedAdrText) {
    sections.push({
      kind: 'embeddedMarkdown',
      heading: 'Architecture Decision',
      content: normalizedAdrText,
    });
  }

  // ── Reviewer Findings ──────────────────────────────────────────────
  appendFindingsSections(sections, {
    blockingIssues,
    majorRisks,
    missingVerification,
    scopeCreep,
    unknowns,
  });

  const document: ReviewCardDocument = {
    kind: 'review_card',
    form:
      !isApproved &&
      productNextAction.commands.some((command) =>
        ['/approve', '/request-changes', '/reject'].includes(command),
      )
        ? 'decision'
        : 'terminal',
    sections,
    conclusion: buildConclusion(productNextAction, isApproved),
  };

  return renderMarkdown(document, options);
}

// ─── Findings Projection ────────────────────────────────────────────────────────

interface FindingInputs {
  blockingIssues?: Array<{
    severity: string;
    category: string;
    message: string;
    location?: string;
  }>;
  majorRisks?: Array<{ severity: string; category: string; message: string; location?: string }>;
  missingVerification?: string[];
  scopeCreep?: string[];
  unknowns?: string[];
}

function toFindingItems(
  raw: Array<{ category: string; message: string; location?: string }>,
): FindingItem[] {
  return raw.map((f) => ({
    category: f.category,
    message: f.message,
    ...(f.location ? { location: f.location } : {}),
  }));
}

function appendFindingsSections(sections: PresentationSection[], inputs: FindingInputs): void {
  const { blockingIssues, majorRisks, missingVerification, scopeCreep, unknowns } = inputs;

  const hasFindings =
    (blockingIssues?.length ?? 0) > 0 ||
    (majorRisks?.length ?? 0) > 0 ||
    (missingVerification?.length ?? 0) > 0 ||
    (scopeCreep?.length ?? 0) > 0 ||
    (unknowns?.length ?? 0) > 0;

  if (!hasFindings) return;

  // Severity-mapped findings: blocking issues (critical) + major risks (major).
  const groups: FindingGroup[] = [];
  if (blockingIssues && blockingIssues.length > 0) {
    groups.push({
      severity: 'critical',
      label: 'Blocking Issues',
      items: toFindingItems(blockingIssues),
    });
  }
  if (majorRisks && majorRisks.length > 0) {
    groups.push({
      severity: 'major',
      label: 'Major Risks',
      items: toFindingItems(majorRisks),
    });
  }
  if (groups.length > 0) {
    sections.push({ kind: 'findings', heading: 'Reviewer Findings', groups });
  }

  // Non-severity categories that do not fit the FindingGroup.severity union
  // are rendered as bullet lists (missing verification, scope creep, unknowns).
  if (missingVerification && missingVerification.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: `Missing Verification (${missingVerification.length})`,
      items: missingVerification,
    });
  }
  if (scopeCreep && scopeCreep.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: `Scope Creep (${scopeCreep.length})`,
      items: scopeCreep,
    });
  }
  if (unknowns && unknowns.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: `Unknowns (${unknowns.length})`,
      items: unknowns,
    });
  }
}

// ─── Conclusion Projection ─────────────────────────────────────────────────────

function buildConclusion(
  productNextAction: { text: string; commands: readonly string[] },
  isApproved: boolean,
): PresentationConclusion {
  if (!isApproved) {
    const commands = new Set(productNextAction.commands);
    const actions: PresentationAction[] = [];
    for (const command of ['/approve', '/request-changes', '/reject']) {
      if (commands.has(command)) {
        actions.push({
          invocation: command,
          description: ADR_ACTION_DESCRIPTIONS[command] ?? command,
          visibility: 'available',
        });
      }
    }
    if (actions.length > 0) {
      return { kind: 'decision_required', question: productNextAction.text, actions };
    }
  }

  return { kind: 'terminal', message: productNextAction.text };
}
