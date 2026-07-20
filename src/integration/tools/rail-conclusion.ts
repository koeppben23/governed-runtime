/**
 * @module integration/tools/rail-conclusion
 * @description Surface-local Next-Action conclusion projection for mutating
 *              rail tools (/plan, /implement, /check, /architecture, /review)
 *              and the /continue dispatcher.
 *
 * This is the rail-surface analogue of the /status, /why, and /finish
 * conclusion builders (see status-conclusion.ts, status-why-finish.ts). It
 * ONLY arranges already-decided data: it derives the user-facing next action
 * from the canonical resolveNextAction / buildProductNextAction authorities and
 * the installed-command metadata catalogue. It never invents commands,
 * descriptions, or decision questions.
 *
 * It is deliberately NOT unified with the status/why/finish projections: each
 * surface carries its own fail-closed semantics (distinct empty-projection
 * codes) so a data-integrity gap on one surface can never be silently masked by
 * another surface's fallback. See docs/trust-boundaries.md.
 *
 * The rail surface is a success surface: after a successful rail transition
 * there is exactly one recommended next action, at a user gate there is an
 * explicit decision, and at a clean terminal there is no further action. The
 * governance `next` field on the tool response is UNCHANGED by this module —
 * this projection produces only the human-facing rendered conclusion.
 *
 * @version v1
 */

import type { SessionState } from '../../state/schema.js';
import type { EvalResult } from '../../machine/evaluate.js';
import type { PresentationConclusion } from '../../presentation/index.js';
import { resolveNextAction } from '../../machine/next-action.js';
import { buildProductNextAction } from '../../presentation/next-action-copy.js';
import { projectStatusActionFromCommand } from '../status-conclusion.js';

/**
 * Project the canonical rail-surface conclusion from state + evalResult.
 *
 * - waiting (user gate) → decision_required with the gate's product commands.
 * - transition / pending (work remains) → next_action with the recommended
 *   product command.
 * - terminal with a product command (e.g. /export, /status) → next_action.
 * - terminal without a product command (clean end) → terminal message.
 *
 * Fail-closed: a state that yields no product command where one is structurally
 * required throws with an explicit RAIL_*_PROJECTION_EMPTY code rather than
 * inventing fallback text.
 */
export function buildRailConclusion(
  state: SessionState,
  evalResult: EvalResult,
): PresentationConclusion {
  const nextAction = resolveNextAction(state.phase, state);
  const productNext = buildProductNextAction(
    nextAction,
    state.phase,
    state.error?.code === 'ABORTED',
    state.archiveStatus ?? null,
  );

  // User gate → decision_required. Actions come from the product commands;
  // the question comes from the evaluator's waiting reason.
  if (evalResult.kind === 'waiting') {
    const actions = productNext.commands.map((invocation) => ({
      ...projectStatusActionFromCommand(invocation, 'available'),
    }));

    if (actions.length === 0) {
      throw Object.assign(
        new Error(
          `RailConclusion: waiting gate has no canonical decision actions: ${evalResult.reason}`,
        ),
        { code: 'RAIL_DECISION_PROJECTION_EMPTY' },
      );
    }

    return {
      kind: 'decision_required',
      question: evalResult.reason,
      actions,
    };
  }

  // Work remains or a terminal phase still routes to a product command
  // (e.g. COMPLETE → /export, aborted → /status): recommend the first command.
  const command = productNext.commands[0];
  if (command !== undefined) {
    return {
      kind: 'next_action',
      action: { ...projectStatusActionFromCommand(command, 'recommended') },
    };
  }

  // No further product command exists → clean terminal.
  if (productNext.text.trim().length === 0) {
    throw Object.assign(new Error('RailConclusion: terminal projection requires non-empty text'), {
      code: 'RAIL_TERMINAL_PROJECTION_EMPTY',
    });
  }

  return { kind: 'terminal', message: productNext.text };
}
