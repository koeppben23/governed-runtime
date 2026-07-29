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
 * Owns the StatusActionProjection and StatusConclusionProjection types
 * to avoid circular imports with status.ts.
 *
 * @version v1
 */

import { evaluate } from '../machine/evaluate.js';
import { buildProductNextAction } from '../presentation/next-action-copy.js';
import { getInstalledCommand } from './installed-commands.js';

// ─── Action Projection ─────────────────────────────────────────────────────────

/**
 * Single action within a status conclusion.
 * Populated from installed-command metadata (invocation + description) and
 * derived visibility from the evaluator result.
 */
export interface StatusActionProjection {
  readonly invocation: string | null;
  readonly description: string;
  readonly visibility: 'recommended' | 'available';
}

// ─── Conclusion Projection ─────────────────────────────────────────────────────

export type StatusConclusionProjection =
  | {
      readonly kind: 'next_action';
      readonly action: StatusActionProjection;
    }
  | {
      readonly kind: 'decision_required';
      readonly question: string;
      readonly actions: readonly StatusActionProjection[];
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
  // Blocked at a User Gate → decision_required
  // question comes from evaluator reason; actions from product commands
  if (evalResult.kind === 'waiting') {
    const actions = productNextAction.commands.map((invocation) =>
      projectStatusActionFromCommand(invocation, 'available'),
    );

    // A waiting gate with no resolvable commands is a data-integrity error.
    // It must not be silently surfaced as a terminal conclusion — a waiting
    // gate is not terminal, and the presentation layer must not invent
    // fallback text to cover a contract deficiency.
    if (actions.length === 0) {
      throw Object.assign(
        new Error(
          `StatusProjection: waiting gate has no canonical decision actions: ${evalResult.reason}`,
        ),
        { code: 'STATUS_DECISION_PROJECTION_EMPTY' },
      );
    }

    return {
      kind: 'decision_required',
      question: evalResult.reason,
      actions,
    };
  }

  if (productNextAction.presentationForm === 'review_pending') {
    return {
      kind: 'review_pending',
      message: productNextAction.text,
    };
  }

  // There are still user actions available → next_action
  const command = productNextAction.commands[0];
  if (command) {
    return {
      kind: 'next_action',
      action: projectStatusActionFromCommand(command, 'recommended'),
    };
  }

  // No further actions exist → terminal
  return {
    kind: 'terminal',
    message: productNextAction.text,
  };
}

/**
 * Project a StatusActionProjection from a command invocation string.
 *
 * Uses getInstalledCommand() to obtain the canonical description — never
 * fabricates description text. Throws when metadata is missing for an
 * invocation that the runtime has selected (this is a data-integrity error,
 * not a recoverable presentation fallback).
 */
export function projectStatusActionFromCommand(
  invocation: string,
  visibility: StatusActionProjection['visibility'],
): StatusActionProjection {
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
  };
}
