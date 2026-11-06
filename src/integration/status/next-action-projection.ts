/**
 * @module integration/status/next-action-projection
 * @description Read-only RPC projection of the canonical next-action decision.
 *
 * The projection copies the existing status conclusion and directive identity.
 * It is not a second state machine, policy evaluator or decision authority.
 */

import { z } from 'zod';

import type { FlowGuardPolicy } from '../../config/policy.js';
import { directiveLabel } from '../../presentation/directive-copy.js';
import type { SessionState } from '../../state/schema.js';
import { computeStateDigest } from '../audit-outbox.js';
import { buildStatusProjection } from './status.js';

export const NextActionRequest = z
  .object({
    sessionID: z.string().min(1),
  })
  .strict();
export type NextActionRequest = z.infer<typeof NextActionRequest>;

const NextActionAction = z
  .object({
    invocation: z.string().min(1),
    description: z.string().min(1),
    visibility: z.enum(['recommended', 'available']),
    intent: z.string().min(1).optional(),
  })
  .strict();
type NextActionAction = z.infer<typeof NextActionAction>;

const NextActionBlocker = z
  .object({
    code: z.string().nullable(),
    message: z.string(),
    recovery: z.string().nullable(),
  })
  .strict();
type NextActionBlocker = z.infer<typeof NextActionBlocker>;

const NextActionKind = z.enum([
  'choose_flow',
  'next_action',
  'decision_required',
  'system_work',
  'blocked',
  'terminal',
]);
type NextActionKind = z.infer<typeof NextActionKind>;

export const NextActionResult = z
  .object({
    schemaVersion: z.literal('next-action.v1'),
    kind: NextActionKind,
    sessionID: z.string().min(1),
    phase: z.string().min(1).nullable(),
    stateDigest: z.string().min(1).nullable(),
    policyDigest: z.string().min(1).nullable(),
    title: z.string().min(1),
    question: z.string().nullable(),
    actions: z.array(NextActionAction),
    blocker: NextActionBlocker.nullable(),
  })
  .strict();
export type NextActionResult = z.infer<typeof NextActionResult>;

function actionsFor(
  conclusion: ReturnType<typeof buildStatusProjection>['conclusion'],
): NextActionAction[] {
  switch (conclusion.kind) {
    case 'next_action':
      return conclusion.action.invocation === null
        ? []
        : [
            {
              invocation: conclusion.action.invocation,
              description: conclusion.action.description,
              visibility: conclusion.action.visibility,
              ...(conclusion.action.intent !== undefined
                ? { intent: conclusion.action.intent }
                : {}),
            },
          ];
    case 'decision_required':
      return conclusion.actions.flatMap((action) =>
        action.invocation === null
          ? []
          : [
              {
                invocation: action.invocation,
                description: action.description,
                visibility: action.visibility,
                ...(action.intent !== undefined ? { intent: action.intent } : {}),
              },
            ],
      );
    case 'recovery':
    case 'terminal':
    case 'review_pending':
      return [];
  }
}

function kindFor(
  directiveCode: string,
  conclusion: ReturnType<typeof buildStatusProjection>['conclusion'],
): NextActionKind {
  if (directiveCode === 'CHOOSE_FLOW' && conclusion.kind === 'decision_required') {
    return 'choose_flow';
  }
  switch (conclusion.kind) {
    case 'next_action':
      return 'next_action';
    case 'decision_required':
      return 'decision_required';
    case 'review_pending':
      return 'system_work';
    case 'recovery':
      return 'blocked';
    case 'terminal':
      return 'terminal';
  }
}

function blockerFor(
  status: ReturnType<typeof buildStatusProjection>,
  conclusion: ReturnType<typeof buildStatusProjection>['conclusion'],
): NextActionBlocker | null {
  if (conclusion.kind === 'recovery') {
    return {
      code: status.blocker?.reasonCode ?? null,
      message: conclusion.message,
      recovery: conclusion.steps.length > 0 ? conclusion.steps.join('\n') : null,
    };
  }
  if (
    status.blocker === null ||
    (status.blocker.reasonCode === null && status.blocker.reasonText === null)
  ) {
    return null;
  }
  return {
    code: status.blocker.reasonCode,
    message: status.blocker.reasonText ?? '',
    recovery: null,
  };
}

/** Project the canonical directive/status conclusion into the native RPC shape. */
export function projectNextActionResult(
  state: SessionState,
  policy: FlowGuardPolicy,
): NextActionResult {
  const status = buildStatusProjection(state, policy);
  const conclusion = status.conclusion;
  const kind = kindFor(status.directive.code, conclusion);
  return {
    schemaVersion: 'next-action.v1',
    kind,
    sessionID: state.binding.hostSessionId,
    phase: state.phase,
    stateDigest: computeStateDigest(state),
    policyDigest: state.policySnapshot?.hash ?? null,
    title: kind === 'choose_flow' ? 'Choose a workflow' : directiveLabel(status.directive.code),
    question: conclusion.kind === 'decision_required' ? conclusion.question : null,
    actions: actionsFor(conclusion),
    blocker: blockerFor(status, conclusion),
  };
}
