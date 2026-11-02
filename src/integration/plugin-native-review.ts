/** V2 hook composition for canonical reviewer dispatch. No capture/evidence/recovery writer. */
import type { Plugin } from '@opencode/plugin';
import type { SessionPrompt, SessionModelRequest } from '@opencode/plugin/promise/session';
import { evaluateProofGraphGate } from '../audit/proofgraph/gate.js';
import { renderPlanClaimDeclarations } from '../presentation/plan-claim-declarations.js';
import { hashText } from '../shared/hashing.js';
import { REVIEWER_SUBAGENT_TYPE } from '../shared/flowguard-identifiers.js';
import type { GovernanceDelegationDispatch } from '../state/governance-activation.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { buildEnforcementError } from './blocked-result.js';
import { nativeHostCallId } from './opencode-host-adapter.js';
import type {
  ActiveGovernanceScope,
  NativeBefore,
  NativeReviewerAuthority,
} from './opencode-governance.js';
import {
  authorizeNativeReviewDispatch,
  bindNativeReviewChild,
  nativeReviewDispatchLineage,
} from './review/dispatch/native-review-dispatch.js';

const HOST_PREFIX = 'You are a subagent spawned by another session.\n';

function deny(reason: string): never {
  throw buildEnforcementError('REVIEW_TASK_EXECUTION_PROVENANCE_UNAVAILABLE', reason);
}

type RuntimeFor = (scope: ActiveGovernanceScope) => Promise<Pick<FlowGuardPluginRuntime, 'ws'>>;

async function stateFor(runtimeFor: RuntimeFor, scope: ActiveGovernanceScope) {
  const runtime = await runtimeFor(scope);
  const resolution = await runtime.ws.resolveSessionAuthority(scope.root.sessionId);
  if (resolution.status !== 'resolved')
    return deny('The ACTIVE review parent state is unavailable.');
  const authority = {
    parentSessionId: scope.root.sessionId,
    policyDigest: scope.root.policyDigest,
    worktreeRoot: scope.root.worktreeRoot,
  };
  return { runtime, ...resolution, authority };
}

async function childLineage(runtimeFor: RuntimeFor, scope: ActiveGovernanceScope) {
  const dispatch = scope.record.parentDispatch;
  if (!dispatch || dispatch.sessionId !== scope.root.sessionId)
    return deny('A reviewer must be the direct child of its authorized review parent.');
  const resolved = await stateFor(runtimeFor, scope);
  const lineage = nativeReviewDispatchLineage(
    resolved.state,
    resolved.authority,
    nativeHostCallId(dispatch.sessionId, dispatch.messageId, dispatch.callId),
    scope.sessionId,
  );
  return { ...resolved, ...lineage };
}

function checkPrompt(text: string, digest: string): void {
  if (!text.startsWith(HOST_PREFIX) || hashText(text.slice(HOST_PREFIX.length)) !== digest)
    deny(
      'Only the exact host-prefixed authorized frozen reviewer prompt may execute. Capture remains blocked.',
    );
}

async function contextFor(
  ctx: Plugin.Context,
  runtimeFor: RuntimeFor,
  scope: ActiveGovernanceScope,
): Promise<void> {
  const { dispatch } = await childLineage(runtimeFor, scope);
  const history = await ctx.session.context({ sessionID: scope.sessionId });
  const users = history.filter((message) => message.type === 'user');
  const user = users[0];
  if (
    users.length !== 1 ||
    !user ||
    history.some((message) => message.type !== 'user' && message.type !== 'assistant') ||
    user.files?.length
  )
    return deny(
      'Only the original un-compacted reviewer request is authorized; continuation/capture remains blocked.',
    );
  checkPrompt(user.text, dispatch.canonicalPromptDigest);
}

export function createNativeReviewerAuthority(ctx: Plugin.Context, runtimeFor: RuntimeFor) {
  const authority: NativeReviewerAuthority = {
    async authorize(scope: ActiveGovernanceScope, event: NativeBefore) {
      if (scope.sessionId !== scope.root.sessionId || event.sessionID !== scope.root.sessionId)
        return deny('Delegated children cannot authorize independent review operations.');
      const args = event.input as Record<string, unknown>;
      if (
        args.agent !== REVIEWER_SUBAGENT_TYPE ||
        (args.background !== undefined && args.background !== false) ||
        Object.keys(args).some(
          (key) => !['agent', 'background', 'description', 'prompt'].includes(key),
        )
      )
        return deny(
          'Reviewer release requires a fresh foreground native child without continuation or model overrides.',
        );
      const resolved = await stateFor(runtimeFor, scope);
      const prompt = await authorizeNativeReviewDispatch({
        deps: resolved.runtime.ws,
        sessDir: resolved.sessDir,
        state: resolved.state,
        authority: resolved.authority,
        enforcement: resolved.runtime.ws.getEnforcementState(scope.root.sessionId),
        hostCallId: nativeHostCallId(event.sessionID, event.messageID, event.id),
        proof: { evaluateProofGraphGate, renderPlanClaimDeclarations },
      });
      args.prompt = prompt;
      args.description = 'FlowGuard independent review';
      args.background = false;
    },
    async bind(
      scope: ActiveGovernanceScope,
      dispatch: GovernanceDelegationDispatch,
      childSessionId: string,
    ) {
      if (dispatch.sessionId !== scope.root.sessionId || dispatch.requestedChildSessionId !== null)
        return deny('Reviewer enrollment must originate from a fresh root review dispatch.');
      const resolved = await stateFor(runtimeFor, scope);
      await bindNativeReviewChild({
        deps: resolved.runtime.ws,
        sessDir: resolved.sessDir,
        authority: resolved.authority,
        hostCallId: nativeHostCallId(dispatch.sessionId, dispatch.messageId, dispatch.callId),
        childSessionId,
      });
    },
    async validate(scope: ActiveGovernanceScope) {
      await childLineage(runtimeFor, scope);
    },
  };
  return {
    ...authority,
    async prompt(scope: ActiveGovernanceScope, event: SessionPrompt) {
      const { dispatch } = await childLineage(runtimeFor, scope);
      if (event.prompt.files?.length || event.prompt.agents?.length || event.prompt.skills?.length)
        return deny(
          'Reviewer prompt attachments, agent mentions and skills are not dispatch authority.',
        );
      checkPrompt(event.prompt.text, dispatch.canonicalPromptDigest);
      if ((await ctx.session.context({ sessionID: scope.sessionId })).length !== 0)
        return deny('The original reviewer prompt cannot be replayed or continued.');
    },
    async context(scope: ActiveGovernanceScope) {
      await contextFor(ctx, runtimeFor, scope);
    },
    async request(scope: ActiveGovernanceScope, event: SessionModelRequest) {
      if ((await ctx.session.get({ sessionID: event.sessionID })).agent !== REVIEWER_SUBAGENT_TYPE)
        return;
      if (event.kind !== 'primary' || event.agent !== REVIEWER_SUBAGENT_TYPE)
        throw buildEnforcementError(
          'REVIEWER_EXECUTION_OUTCOME_UNKNOWN',
          'Auxiliary reviewer requests are not authorized by dispatch.',
        );
      await contextFor(ctx, runtimeFor, scope);
    },
  };
}
