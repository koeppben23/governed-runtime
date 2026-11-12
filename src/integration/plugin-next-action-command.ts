/**
 * @module integration/plugin-next-action-command
 * @description Read-only Next Action RPC and revision-bound native decision
 * submission. Both consume canonical authorities; neither introduces a second
 * state machine or decision path.
 */

import type { Plugin } from '@opencode/plugin';

import { resolveSessionAuthority } from '../adapters/session-authority.js';
import {
  resolveGovernanceActivation,
  type GovernanceActivationStore,
} from '../adapters/governance-activation.js';
import { resolvePolicyFromSnapshot } from '../config/policy-snapshot.js';
import { ReviewVerdict } from '../state/evidence.js';
import { executeDecisionCommand, type DecisionCommandDeps } from './plugin-decision-command.js';
import { getInstalledCommand } from './installed-commands.js';
import type {
  NextActionDecisionRequest,
  NextActionDecisionResult,
} from './opencode-governance-rpc.js';
import { TOOL_FLOWGUARD_DECISION } from './tool-names.js';
import { projectNextActionResult, type NextActionResult } from './status/next-action-projection.js';
import { DecisionArgsSchema } from './workflow-decision-invocation.js';

export interface NextActionCommandDeps extends DecisionCommandDeps {
  readonly governance: DecisionCommandDeps['governance'] & {
    readonly store: GovernanceActivationStore;
  };
}

const NO_ACTIVATION_BINDING = {
  activationId: null,
  activationGeneration: null,
  decisionBinding: null,
} as const;

export async function getNextAction(
  ctx: Plugin.Context,
  governance: NextActionCommandDeps['governance'],
  request: { readonly sessionID: string },
): Promise<NextActionResult> {
  const activation = await resolveGovernanceActivation(governance.store, request.sessionID);
  if (activation.kind !== 'active') {
    return {
      schemaVersion: 'next-action.v1',
      kind: 'blocked',
      sessionID: request.sessionID,
      ...NO_ACTIVATION_BINDING,
      phase: null,
      stateDigest: null,
      policyDigest: null,
      title: 'FlowGuard governance is not active',
      question: null,
      actions: [],
      blocker: {
        code: activation.kind === 'blocked' ? activation.code : 'GOVERNANCE_INACTIVE',
        message:
          activation.kind === 'blocked'
            ? activation.reason
            : 'Run /start before choosing a workflow.',
        recovery: 'Run /start to activate governance, then choose a workflow.',
      },
    } satisfies NextActionResult;
  }

  const authority = await resolveSessionAuthority({
    root: ctx.location.directory,
    sessionId: request.sessionID,
  });
  if (authority.status === 'resolved') {
    return {
      ...projectNextActionResult(
        authority.state,
        resolvePolicyFromSnapshot(authority.state.policySnapshot),
        activation.record,
      ),
      sessionID: request.sessionID,
    };
  }
  return {
    schemaVersion: 'next-action.v1',
    kind: 'blocked',
    sessionID: request.sessionID,
    activationId: activation.record.activationId,
    activationGeneration: activation.record.generation,
    decisionBinding: null,
    phase: null,
    stateDigest: null,
    policyDigest: null,
    title: 'FlowGuard session unavailable',
    question: null,
    actions: [],
    blocker: {
      code: authority.status === 'absent' ? 'SESSION_STATE_ABSENT' : authority.code,
      message:
        authority.status === 'absent'
          ? 'No FlowGuard state exists for this session.'
          : authority.reason,
      recovery: 'Start or hydrate a governed session, then retry.',
    },
  };
}

function blockedDecision(code: string, reason: string): NextActionDecisionResult {
  return { kind: 'blocked', code, reason };
}

/** A native decision control is a request to execute one canonical command. */
export async function submitDecision(
  ctx: Plugin.Context,
  deps: NextActionCommandDeps,
  request: NextActionDecisionRequest,
): Promise<NextActionDecisionResult> {
  try {
    const command = getInstalledCommand(request.invocation);
    const verdict =
      command?.target.toolName === TOOL_FLOWGUARD_DECISION
        ? command.target.fixedArgs?.verdict
        : undefined;
    if (verdict === undefined) {
      return blockedDecision(
        'DECISION_COMMAND_UNSUPPORTED',
        'The selected action is not a canonical native decision command.',
      );
    }
    const args = DecisionArgsSchema.parse({
      verdict: ReviewVerdict.parse(verdict),
      rationale: request.rationale ?? '',
    });
    await executeDecisionCommand(ctx, deps, {
      sessionID: request.sessionID,
      command: request.invocation,
      args,
      expectedBinding: request.expected,
    });
    return { kind: 'applied', invocation: request.invocation };
  } catch (error) {
    return blockedDecision(
      error instanceof Error && 'code' in error && typeof error.code === 'string'
        ? error.code
        : 'GOVERNANCE_AUTHORITY_BLOCKED',
      error instanceof Error ? error.message : String(error),
    );
  }
}
