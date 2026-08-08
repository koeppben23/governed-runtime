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
