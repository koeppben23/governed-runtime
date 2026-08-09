/**
 * @module integration/status-conclusion
 * @description Status conclusion projection — derives the canonical conclusion
 *              from evalResult and productNextAction.
 *
 * The conclusion is fully decided upstream: this module only translates
 * already-decided evalResults and productNextAction commands into a typed
 * conclusion without inventing blocker semantics, recovery text, or
 * decision questions.
 *
 * Uses the canonical PresentationAction as the single action representation
 * (no parallel StatusActionProjection).
 *
 * @version v2
 */

import { evaluate } from '../machine/evaluate.js';
import { buildProductNextAction } from '../presentation/next-action-copy.js';
import { getInstalledCommand } from './installed-commands.js';
import type { PresentationAction } from '../presentation/index.js';

// ─── Conclusion Projection ─────────────────────────────────────────────────────

export type StatusConclusionProjection =
  | {
      readonly kind: 'next_action';
      readonly action: PresentationAction;
    }
  | {
      readonly kind: 'decision_required';
      readonly question: string;
      readonly actions: readonly PresentationAction[];
    }
  | {
      readonly kind: 'terminal';
      readonly message: string;
    }
  | {
      readonly kind: 'review_pending';
      readonly message: string;
    };

// ─── Conclusion Builder ────────────────────────────────────────────────────────

/**
 * Project the canonical status conclusion from evalResult and productNextAction.
 *
 * Presentation-terminal (kind: 'terminal') means: there is NO further
 * recommended or required user action. This is NOT the same as the machine
 * evaluator's 'terminal' kind — a completed session with a pending /export
 * remains a 'next_action' with invocation '/export'.
 */
export function projectStatusConclusion(
  evalResult: ReturnType<typeof evaluate>,
  productNextAction: ReturnType<typeof buildProductNextAction>,
): StatusConclusionProjection {
  if (evalResult.kind === 'waiting') {
    const actions = productNextAction.commands.map((invocation) =>
      projectStatusActionFromCommand(invocation, 'available'),
    );

    if (actions.length === 0) {
      throw Object.assign(
        new Error(
          `StatusProjection: waiting gate has no canonical decision actions: ${evalResult.reason}`,
        ),
        { code: 'STATUS_DECISION_PROJECTION_EMPTY' },
      );
    }

    return { kind: 'decision_required', question: evalResult.reason, actions };
  }

  if (productNextAction.presentationForm === 'review_pending') {
    return { kind: 'review_pending', message: productNextAction.text };
  }

  const command = productNextAction.commands[0];
  if (command) {
    return {
      kind: 'next_action',
      action: projectStatusActionFromCommand(command, 'recommended'),
    };
  }

  return { kind: 'terminal', message: productNextAction.text };
}

/**
 * Project a PresentationAction from a command invocation string.
 *
 * Uses getInstalledCommand() to obtain the canonical description and intent —
 * never fabricates description text. Throws when metadata is missing for an
 * invocation that the runtime has selected.
 */
export function projectStatusActionFromCommand(
  invocation: string,
  visibility: PresentationAction['visibility'],
): PresentationAction {
  const command = getInstalledCommand(invocation);

  if (!command) {
    throw Object.assign(
      new Error(
        `StatusProjection: no installed command metadata for "${invocation}". ` +
          'The runtime selected a command without presentation metadata in INSTALLED_COMMANDS.',
      ),
      { code: 'STATUS_ACTION_PROJECTION_MISSING_METADATA' },
    );
  }

  return {
    invocation: command.invocation,
    description: command.description,
    visibility,
    ...(command.intent ? { intent: command.intent } : {}),
  };
}
