/** Canonical export-completion rail. */

import { Command, isCommandAllowed } from '../machine/commands.js';
import { evaluate, evaluateWithEvent } from '../machine/evaluate.js';
import type { ExportCompletionEvidence, SessionState } from '../state/schema.js';
import {
  applyTransition,
  type RailContext,
  type RailResult,
  type TransitionRecord,
} from './types.js';
import { blocked } from '../config/reasons.js';

/** Advance a development session only after export materialization evidence exists. */
export function executeExport(
  state: SessionState,
  evidence: ExportCompletionEvidence,
  ctx: RailContext,
): RailResult {
  if (!isCommandAllowed(state.phase, Command.EXPORT)) {
    return blocked('COMMAND_NOT_ALLOWED', { command: '/export', phase: state.phase });
  }
  const target = evaluateWithEvent(state.phase, 'EXPORT_MATERIALIZED');
  if (!target) {
    return blocked('INVALID_TRANSITION', { event: 'EXPORT_MATERIALIZED', phase: state.phase });
  }
  const at = ctx.now();
  const finalState = applyTransition(
    { ...state, exportCompletionEvidence: evidence },
    state.phase,
    target,
    'EXPORT_MATERIALIZED',
    at,
  );
  const transition: TransitionRecord = {
    from: state.phase,
    to: target,
    event: 'EXPORT_MATERIALIZED',
    at,
  };
  return {
    kind: 'ok',
    state: finalState,
    evalResult: evaluate(finalState, ctx.policy),
    transitions: [transition],
  };
}
