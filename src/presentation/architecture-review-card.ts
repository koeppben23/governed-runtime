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
import type { ArchitectureReviewCompletion } from '../state/evidence.js';
import type {
  ReviewCardDocument,
  PresentationSection,
  KeyValueItem,
  FindingGroup,
  FindingItem,
  FindingRelationPresentation,
} from './model.js';
import { projectFindingRelation } from './finding-relation.js';
import { renderMarkdown } from './markdown.js';
import type { PresentationRenderOptions } from './glyph-profile.js';
import type { CompactProofPresentation } from './proof-model.js';
import { buildProofGraphSection } from './proof-summary.js';
import { buildReviewDecisionConclusion, type DirectiveProjection } from './review-decision.js';
import { directiveLabel } from './directive-copy.js';

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
  /** Independent review iteration number. */
  iteration: number;
  /** Subagent overall verdict. */
  overallVerdict?: string;
  /** Blocking issues from review findings. */
  blockingIssues?: Array<{
    severity: string;
    category: string;
    message: string;
    relation?: FindingRelationPresentation;
  }>;
  /** Major risks from review findings. */
  majorRisks?: Array<{
    severity: string;
    category: string;
    message: string;
    relation?: FindingRelationPresentation;
  }>;
  /** Missing verifications. */
  missingVerification?: string[];
  /** Scope creep items. */
  scopeCreep?: string[];
  /** Unknowns. */
  unknowns?: string[];
  /** Canonical workflow directive projection (code + commands verbatim). */
  directive: DirectiveProjection;
  /** True when the ADR has been approved (ARCH_COMPLETE). */
  isApproved: boolean;
  /** Typed reviewer-cycle evidence, separate from human approval. */
  reviewCompletion?: ArchitectureReviewCompletion;
  /** Compact ProofGraph summary for the review card (decision claims). */
  proofSummary: CompactProofPresentation;
  /** Digest of the artifact revision these findings were bound to. */
  reviewedDigest?: string;
  /** Obligation that produced these findings. */
  reviewedObligationId?: string;
}

// ─── Action Descriptions ───────────────────────────────────────────────────────

const ADR_ACTION_DESCRIPTIONS: Record<string, string> = {
  '/approve': 'approve the ADR if it is complete and acceptable',
  '/override-approve': 'accept the exhausted ADR review with a recorded governance override',
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
  return renderMarkdown(buildArchitectureReviewDocument(input), options);
}

/** Build the typed architecture-review document before Markdown rendering. */
export function buildArchitectureReviewDocument(
  input: ArchitectureReviewCardInput,
): ReviewCardDocument {
  const sections: PresentationSection[] = [
    { kind: 'title', text: 'FlowGuard Architecture Review' },
    buildArchitectureMetadataSection(input),
  ];

  sections.push(...buildArchitectureWarningNotices(input));

  sections.push(buildProofGraphSection(input.proofSummary));

  const details = buildAdrDetailsSection(input);
  if (details) sections.push(details);

  const body = buildAdrBodySection(input.adrText);
  if (body) sections.push(body);

  appendFindingsSections(sections, {
    blockingIssues: input.blockingIssues,
    majorRisks: input.majorRisks,
    missingVerification: input.missingVerification,
    scopeCreep: input.scopeCreep,
    unknowns: input.unknowns,
  });

  return buildArchitectureReviewDocumentShell(input, sections);
}

/** Metadata section (ADR title when present, status, verdict). */
function buildArchitectureMetadataSection(input: ArchitectureReviewCardInput): PresentationSection {
  const metadata: KeyValueItem[] = [];
  if (input.adrTitle) metadata.push({ label: 'ADR', value: input.adrTitle });
  metadata.push({ label: 'Status', value: input.phaseLabel });
  metadata.push({ label: 'Verdict', value: input.overallVerdict ?? 'pending' });
  return { kind: 'keyValue', items: metadata };
}

/**
 * Warning notices for an unreviewed/force-converged ADR: review exhaustion and
 * the prior-revision provenance mismatch (the displayed findings were bound to
 * a different artifact revision than the one at this gate). Both notices may
 * apply to the same card and render in this order.
 */
function buildArchitectureWarningNotices(
  input: ArchitectureReviewCardInput,
): PresentationSection[] {
  const notices: PresentationSection[] = [];
  if (input.reviewCompletion === 'review_exhausted' && !input.isApproved) {
    notices.push({
      kind: 'notice',
      level: 'warning',
      message: 'Reviewer did NOT approve this ADR.',
      additionalMessages: [
        'The independent review reached its iteration limit without reviewer acceptance. ' +
          'Review the outstanding findings carefully before making the required human decision.',
      ],
      details: [],
    });
  }
  if (input.reviewedDigest && input.adrDigest && input.reviewedDigest !== input.adrDigest) {
    notices.push({
      kind: 'notice',
      level: 'warning',
      message: 'These reviewer findings apply to a prior artifact revision.',
      additionalMessages: [
        `Reviewed digest: \`${input.reviewedDigest}\``,
        `Current digest:  \`${input.adrDigest}\``,
        'The current revision was submitted after the final independent review ' +
          'and has not itself been independently reviewed.',
      ],
      details: [],
    });
  }
  return notices;
}

function buildAdrDetailItems(input: ArchitectureReviewCardInput): KeyValueItem[] {
  const items: KeyValueItem[] = [];
  if (input.adrId) items.push({ label: 'ID', value: `\`${input.adrId}\`` });
  if (input.adrDigest) items.push({ label: 'Digest', value: `\`${input.adrDigest}\`` });
  if (input.iteration > 0) {
    items.push({ label: 'Review iteration', value: String(input.iteration) });
  }
  if (input.reviewedDigest) {
    items.push({ label: 'Reviewed ADR digest', value: `\`${input.reviewedDigest}\`` });
  }
  if (input.reviewedObligationId) {
    items.push({ label: 'Reviewed obligation', value: `\`${input.reviewedObligationId}\`` });
  }
  return items;
}

function buildAdrDetailsSection(
  input: ArchitectureReviewCardInput,
): PresentationSection | undefined {
  const hasDetails = input.adrId || input.adrDigest || input.iteration > 0 || input.reviewedDigest;
  if (!hasDetails) return undefined;
  return { kind: 'keyValue', heading: 'ADR Details', items: buildAdrDetailItems(input) };
}

function buildAdrBodySection(adrText: string | undefined): PresentationSection | undefined {
  const normalizedAdrText = adrText?.trim();
  return normalizedAdrText
    ? { kind: 'embeddedMarkdown', heading: 'Architecture Decision', content: normalizedAdrText }
    : undefined;
}

function buildArchitectureReviewDocumentShell(
  input: ArchitectureReviewCardInput,
  sections: PresentationSection[],
): ReviewCardDocument {
  return {
    kind: 'review_card',
    form: !input.isApproved && input.directive.kind === 'human_gate' ? 'decision' : 'terminal',
    sections,
    conclusion: input.isApproved
      ? { kind: 'terminal', message: directiveLabel(input.directive.code) }
      : buildReviewDecisionConclusion(input.directive, ADR_ACTION_DESCRIPTIONS),
  };
}

// ─── Findings Projection ────────────────────────────────────────────────────────

interface FindingInputs {
  blockingIssues?:
    | Array<{
        severity: string;
        category: string;
        message: string;
        relation?: FindingRelationPresentation;
      }>
    | undefined;
  majorRisks?:
    | Array<{
        severity: string;
        category: string;
        message: string;
        relation?: FindingRelationPresentation;
      }>
    | undefined;
  missingVerification?: string[] | undefined;
  scopeCreep?: string[] | undefined;
  unknowns?: string[] | undefined;
}

function toFindingItems(
  raw: Array<{ category: string; message: string; relation?: FindingRelationPresentation }>,
): FindingItem[] {
  return raw.map((f) => ({
    category: f.category,
    message: f.message,
    ...projectFindingRelation(f.relation),
  }));
}

function hasItems(items: readonly unknown[] | undefined): boolean {
  return (items?.length ?? 0) > 0;
}

function hasAnyFindings(inputs: FindingInputs): boolean {
  return (
    hasItems(inputs.blockingIssues) ||
    hasItems(inputs.majorRisks) ||
    hasItems(inputs.missingVerification) ||
    hasItems(inputs.scopeCreep) ||
    hasItems(inputs.unknowns)
  );
}

/** Severity-mapped findings: blocking issues (critical) + major risks (major). */
function toSeverityGroups(inputs: FindingInputs): FindingGroup[] {
  const groups: FindingGroup[] = [];
  if (inputs.blockingIssues && inputs.blockingIssues.length > 0) {
    groups.push({
      severity: 'critical',
      label: 'Blocking Issues',
      items: toFindingItems(inputs.blockingIssues),
    });
  }
  if (inputs.majorRisks && inputs.majorRisks.length > 0) {
    groups.push({
      severity: 'major',
      label: 'Major Risks',
      items: toFindingItems(inputs.majorRisks),
    });
  }
  return groups;
}

function appendBulletList(
  sections: PresentationSection[],
  heading: string,
  items: string[] | undefined,
): void {
  if (items && items.length > 0) {
    sections.push({
      kind: 'bulletList',
      heading: `${heading} (${items.length})`,
      items,
    });
  }
}

function appendFindingsSections(sections: PresentationSection[], inputs: FindingInputs): void {
  if (!hasAnyFindings(inputs)) return;

  const groups = toSeverityGroups(inputs);
  if (groups.length > 0) {
    sections.push({ kind: 'findings', heading: 'Reviewer Findings', detail: 'compact', groups });
  }

  // Non-severity categories that do not fit the FindingGroup.severity union
  // are rendered as bullet lists (missing verification, scope creep, unknowns).
  appendBulletList(sections, 'Missing Verification', inputs.missingVerification);
  appendBulletList(sections, 'Scope Creep', inputs.scopeCreep);
  appendBulletList(sections, 'Unknowns', inputs.unknowns);
}
