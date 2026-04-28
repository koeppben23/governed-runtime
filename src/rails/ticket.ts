/**
 * @module ticket
 * @description /ticket rail — record a ticket (task description).
 *
 * Behavior:
 * 1. Validate command admissibility
 * 2. Validate input (non-empty text)
 * 3. Create TicketEvidence with digest
 * 4. Clear all downstream evidence (re-ticketing = fresh start)
 * 5. Auto-advance (evaluate + transition if possible)
 *
 * After /ticket, the machine is at TICKET with ticket evidence.
 * To proceed, the user must /plan (which advances to PLAN).
 *
 * @version v1
 */

import type { SessionState } from '../state/schema.js';
import type { TicketEvidence, ExternalReference, InputOrigin } from '../state/evidence.js';
import { Command, isCommandAllowed } from '../machine/commands.js';
import { evaluate } from '../machine/evaluate.js';
import type { RailResult, RailContext, TransitionRecord } from './types.js';
import { autoAdvance } from './types.js';
import { blocked } from '../config/reasons.js';

// ─── Input ────────────────────────────────────────────────────────────────────

export interface TicketInput {
  readonly text: string;
  readonly source: 'user' | 'external';
  readonly inputOrigin?: InputOrigin;
  readonly references?: ExternalReference[];
}

// ─── Rail ─────────────────────────────────────────────────────────────────────

export function executeTicket(
  state: SessionState,
  input: TicketInput,
  ctx: RailContext,
): RailResult {
  // 1. Admissibility
  if (!isCommandAllowed(state.phase, Command.TICKET)) {
    return blocked('COMMAND_NOT_ALLOWED', {
      command: '/ticket',
      phase: state.phase,
    });
  }

  // 2. Validate input
  if (!input.text.trim()) {
    return blocked('EMPTY_TICKET');
  }

  // 3. Create evidence
  const references =
    input.references && input.references.length > 0 ? input.references : undefined;

  const ticket: TicketEvidence = {
    text: input.text,
    digest: ctx.digest(input.text),
    source: input.source,
    createdAt: ctx.now(),
    ...(input.inputOrigin !== undefined && { inputOrigin: input.inputOrigin }),
    ...(references !== undefined && { references }),
  };

  // 4. Mutate state — clear all downstream evidence (fresh start)
  //    If called from READY, transition to TICKET first (flow selection).
  const preTransitions: TransitionRecord[] = [];
  let basePhase = state.phase;
  let baseTransition = state.transition;

  if (state.phase === 'READY') {
    const at = ctx.now();
    basePhase = 'TICKET';
    const tr: TransitionRecord = { from: 'READY', to: 'TICKET', event: 'TICKET_SELECTED', at };
    preTransitions.push(tr);
    baseTransition = { from: tr.from, to: tr.to, event: tr.event, at: tr.at };
  }

  const nextState: SessionState = {
    ...state,
    phase: basePhase,
    transition: baseTransition,
    ticket,
    plan: null,
    selfReview: null,
    validation: [],
    implementation: null,
    implReview: null,
    reviewDecision: null,
    error: null,
  };

  // 5. Auto-advance (policy-aware)
  const evalFn = (s: SessionState) => evaluate(s, ctx.policy);
  const {
    state: finalState,
    evalResult: result,
    transitions: advanceTransitions,
  } = autoAdvance(nextState, evalFn, ctx);
  const transitions = [...preTransitions, ...advanceTransitions];

  return { kind: 'ok', state: finalState, evalResult: result, transitions };
}
