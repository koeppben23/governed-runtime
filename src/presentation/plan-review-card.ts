/**
 * @module presentation/plan-review-card
 * @description Pure presentation builder for the Plan Review Card.
 *
 * Builds a markdown card presenting the full plan with context metadata
 * and recommended next actions. Called only when independent review converges
 * (phase PLAN_REVIEW), never during active plan refinement.
 *
 * This is a pure function — no state dependency, no side effects.
 * The canonical plan body lives in state.plan.current.body and is
 * embedded verbatim.
 *
 * @version v1
 */

import type { Phase } from '../state/schema.js';

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
}

// ─── Card Builder ────────────────────────────────────────────────────────────

/**
 * Build a Plan Review Card as a markdown string.
 *
 * The card renders in 4 sections:
 * 1. Header with phase label status
 * 2. Metadata (version, policy, task — only when present)
 * 3. The full plan body verbatim
 * 4. Recommended next actions derived from productNextAction.commands
 *
 * Status text distinguishes "ready for approval" from "approved" —
 * the latter only happens after /approve is executed, never in this card.
 */
export function buildPlanReviewCard(input: PlanReviewCardInput): string {
  const { planText, phaseLabel, productNextAction, planVersion, policyMode, taskTitle } = input;

  const commands = new Set(productNextAction.commands);
  const hasApprove = commands.has('/approve');
  const hasRequestChanges = commands.has('/request-changes');
  const hasReject = commands.has('/reject');

  // ── Section 1: Header ──────────────────────────────────────────────
  const header = ['# FlowGuard Plan Review', '', `> **Status:** ${phaseLabel}`];

  // ── Section 2: Metadata ────────────────────────────────────────────
  if (planVersion !== undefined && Number.isInteger(planVersion) && planVersion > 0) {
    header.push(`> **Plan version:** v${planVersion}`);
  }
  if (policyMode) {
    header.push(`> **Policy:** ${policyMode}`);
  }
  if (taskTitle) {
    header.push(`> **Task:** ${taskTitle}`);
  }

  // ── Section 3: Plan Body ───────────────────────────────────────────
  const body = ['', '---', '', '## Proposed Plan', '', planText];

  // ── Section 4: Footer ──────────────────────────────────────────────
  const footer = ['', '---', '', '## Next recommended action', '', productNextAction.text];

  if (hasApprove || hasRequestChanges || hasReject) {
    const options: string[] = [];
    if (hasApprove)
      options.push('- `/approve` — approve the plan if it is complete and acceptable');
    if (hasRequestChanges) options.push('- `/request-changes` — send the plan back for revision');
    if (hasReject) options.push('- `/reject` — stop this task');

    footer.push('');
    footer.push(...options);
  }

  return [...header, ...body, ...footer].join('\n');
}
