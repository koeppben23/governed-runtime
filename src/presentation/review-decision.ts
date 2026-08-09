/**
 * @module presentation/review-decision
 * @description Shared projection for human decision gate conclusions.
 *
 * Used by decision-gated review cards so they share the same deterministic mapping from
 * product-next-action data to a typed PresentationConclusion.
 *
 * @version v1
 */

import type { PresentationAction, PresentationConclusion } from './model.js';

const GATE_COMMANDS = ['/approve', '/request-changes', '/reject'] as const;

/**
 * Project a human decision conclusion from the canonical product-next-action.
 *
 * When the product-next-action commands include `/approve`, `/request-changes`,
 * or `/reject`, this returns `decision_required` with the corresponding actions.
 * Otherwise it returns `terminal` with the action text as fallback.
 *
 * @param productNextAction  — canonical next-action data from
 *   `buildProductNextAction()` (see plan-response.ts / next-action-copy.ts).
 * @param descriptions       — human-readable label for each gate command.
 *   Use distinct labels per card context (plan vs evidence vs architecture).
 */
export function buildReviewDecisionConclusion(
  productNextAction: { text: string; commands: readonly string[] },
  descriptions: Record<string, string>,
): PresentationConclusion {
  const commands = new Set(productNextAction.commands);
  const actions: PresentationAction[] = [];
  for (const command of GATE_COMMANDS) {
    if (commands.has(command)) {
      actions.push({
        invocation: command,
        description: descriptions[command] ?? command,
        visibility: 'available',
      });
    }
  }

  if (actions.length > 0) {
    return {
      kind: 'decision_required',
      question: productNextAction.text,
      actions,
    };
  }

  return { kind: 'terminal', message: productNextAction.text };
}

// ─── Review Decision Projection ────────────────────────────────────────────────

/**
 * Compressed readiness posture of the current review state.
 *
 *   ready     — no canonical blockers prevent the human decision.
 *   not_ready — canonical blockers exist that prevent the decision.
 *
 * Presentation-only. Never authorizes approval. Risk visibility does not
 * change readiness; the human decides.
 */
export type ReviewDecisionReadiness = 'ready' | 'not_ready';

/** Canonical source category of a decision-relevant issue. */
export type DecisionIssueSource = 'review_finding' | 'verification' | 'governance' | 'policy';

/** One decision-relevant issue, projected from canonical review/governance data. */
export interface DecisionIssue {
  readonly source: DecisionIssueSource;
  readonly title: string;
  readonly detail?: string;
  readonly findingId?: string;
  readonly claimId?: string;
  readonly reasonCode?: string;
}

/** Review observations that do not affect readiness but remain visible. */
export type DecisionAdvisory =
  | { readonly kind: 'missing_verification'; readonly text: string }
  | { readonly kind: 'scope_creep'; readonly text: string }
  | { readonly kind: 'unknown'; readonly text: string };

/** Canonical, read-only review decision projection. */
export interface ReviewDecisionProjection {
  readonly readiness: ReviewDecisionReadiness;
  readonly blockers: readonly DecisionIssue[];
  readonly risks: readonly DecisionIssue[];
  readonly advisories: readonly DecisionAdvisory[];
  readonly summary: string;
}

// ─── Readiness Copy ────────────────────────────────────────────────────────────

interface ReadinessCopy {
  readonly headline: string;
  readonly explanation: string;
}

export const REVIEW_DECISION_COPY: Readonly<Record<ReviewDecisionReadiness, ReadinessCopy>> = {
  ready: {
    headline: 'Ready for human decision.',
    explanation: 'No blocking review issues remain.',
  },
  not_ready: {
    headline: 'Not ready for decision.',
    explanation: 'Blocking review issues must be resolved before a decision can proceed.',
  },
};

// ─── Projector ─────────────────────────────────────────────────────────────────

export interface ReviewDecisionInput {
  readonly blockingIssues?: ReadonlyArray<{
    readonly message: string;
    readonly severity?: string;
    readonly category?: string;
    readonly location?: string;
    readonly findingId?: string;
  }>;
  readonly majorRisks?: ReadonlyArray<{
    readonly message: string;
    readonly severity?: string;
    readonly category?: string;
    readonly location?: string;
  }>;
  readonly missingVerification?: readonly string[];
  readonly scopeCreep?: readonly string[];
  readonly unknowns?: readonly string[];
}

function toDecisionIssues(
  source: DecisionIssueSource,
  findings?: ReadonlyArray<{
    readonly message: string;
    readonly severity?: string;
    readonly location?: string;
    readonly findingId?: string;
  }>,
): DecisionIssue[] {
  if (!findings || findings.length === 0) return [];
  return findings.map((f) => ({
    source,
    title: f.message,
    ...(f.severity ? { detail: `Severity: ${f.severity}` } : {}),
    ...(f.location ? { detail: `${f.location}` } : {}),
    ...(f.findingId ? { findingId: f.findingId } : {}),
  }));
}

function toAdvisories(input: ReviewDecisionInput): DecisionAdvisory[] {
  const out: DecisionAdvisory[] = [];
  for (const text of input.missingVerification ?? []) {
    out.push({ kind: 'missing_verification', text });
  }
  for (const text of input.scopeCreep ?? []) {
    out.push({ kind: 'scope_creep', text });
  }
  for (const text of input.unknowns ?? []) {
    out.push({ kind: 'unknown', text });
  }
  return out;
}

function buildSummary(readiness: ReviewDecisionReadiness, blockers: number): string {
  const copy = REVIEW_DECISION_COPY[readiness];
  if (readiness === 'not_ready') {
    return `${copy.explanation} (${blockers} blocking issue${blockers === 1 ? '' : 's'})`;
  }
  return copy.explanation;
}

export function projectReviewDecision(input: ReviewDecisionInput): ReviewDecisionProjection {
  const blockers = toDecisionIssues('review_finding', input.blockingIssues);
  const risks = toDecisionIssues('review_finding', input.majorRisks);
  const advisories = toAdvisories(input);
  const readiness: ReviewDecisionReadiness = blockers.length > 0 ? 'not_ready' : 'ready';

  return {
    readiness,
    blockers,
    risks,
    advisories,
    summary: buildSummary(readiness, blockers.length),
  };
}
