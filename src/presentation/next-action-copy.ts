/**
 * @module presentation/next-action-copy
 * @description Product-friendly next-action text projection.
 *
 * Pure presentation layer over the canonical next-action resolver.
 * The machine layer (src/machine/next-action.ts) remains canonical-only.
 *
 * This module maps machine `code` values to product-oriented display text
 * and command labels. It never changes the underlying authority — only how
 * it is presented to human users.
 *
 * @version v1
 */

import type { NextAction } from '../machine/next-action.js';
import { ACTION_CODES } from '../machine/next-action.js';
import type { Phase } from '../state/schema.js';
import { PHASE_LABELS } from './phase-labels.js';

// ─── Product Guidance ─────────────────────────────────────────────────

/**
 * Product-friendly display for each next-action code.
 * Maps machine codes to user-facing guidance text and product command names.
 */
type ActionCode = (typeof ACTION_CODES)[keyof typeof ACTION_CODES];

const PRODUCT_GUIDANCE = {
  CHOOSE_FLOW: {
    text: 'Choose your workflow: /task (development), /architecture (ADR), /review (compliance).',
    commands: ['/task', '/architecture', '/review'],
  },
  RUN_TICKET: {
    text: 'Describe your governed task with /task',
    commands: ['/task'],
  },
  RUN_PLAN: {
    text: 'Task captured. Generate an implementation plan with /plan',
    commands: ['/plan'],
  },
  RUN_REVIEW_DECISION: {
    text: 'Review gate active. Run /approve to accept, /request-changes to revise, or /reject to discard.',
    commands: ['/approve', '/request-changes', '/reject'],
  },
  RUN_VALIDATE: {
    text: 'Run validation checks with /check',
    commands: ['/check'],
  },
  RUN_CONTINUE: {
    text: 'Run /continue to proceed',
    commands: ['/continue'],
  },
  RUN_IMPLEMENT: {
    text: 'Execute the approved plan with /implement',
    commands: ['/implement'],
  },
  SESSION_COMPLETE: {
    text: 'Workflow complete. Run /export to create a verifiable audit package.',
    commands: ['/export'],
  },
  RUN_ARCHITECTURE: {
    text: 'Submit your Architecture Decision Record with /architecture',
    commands: ['/architecture'],
  },
} satisfies Partial<Record<ActionCode, { text: string; commands: readonly string[] }>>;

/**
 * Resolve product-friendly next action text and commands for a phase.
 *
 * Uses the canonical next-action `code` to look up product guidance.
 * Phase context enriches terminal-phase messages with flow-specific labels.
 *
 * @param action - Canonical next action from the machine layer.
 * @param phase - Current phase for context enrichment.
 * @returns Product-friendly display guidance.
 */
export function buildProductNextAction(
  action: NextAction,
  phase: Phase,
): { text: string; commands: readonly string[] } {
  const code = action.code as ActionCode;
  const guidance = PRODUCT_GUIDANCE[code];

  if (!guidance) {
    return { text: action.text, commands: action.commands };
  }

  const phaseLabel = PHASE_LABELS[phase];

  // Enrich terminal messages with the phase label for context
  if (action.code === 'SESSION_COMPLETE') {
    return {
      text: `${phaseLabel}. Run /export to create a verifiable audit package.`,
      commands: guidance.commands,
    };
  }

  return guidance;
}
