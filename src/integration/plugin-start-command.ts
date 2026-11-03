/**
 * Native `/start`: the host command channel opts exactly one root session into
 * governance. Sessions stay INACTIVE and untouched until this command runs. The
 * channel cannot distinguish operator UI from SDK or agent callers, so the
 * decision is recorded as `host_command` with the canonically resolved actor and
 * never as a verified human (ADR-010 D3).
 *
 * Order: the workflow is hydrated first so the activation binds its frozen
 * policy digest and worktree; then Start and its completion commit under one
 * activation lock. A repeated `/start` completes an interrupted Start of the same
 * decision and is otherwise idempotent.
 */
import type { Plugin } from '@opencode/plugin';
import { resolveActorForPolicy } from '../adapters/actor-context.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { resolvePolicyFromSnapshot } from '../config/policy-snapshot.js';
import type { ActorInfo } from '../state/evidence-identity.js';
import type { GovernanceDecisionActor } from '../state/governance-activation.js';
import { POLICY_MODES, PolicyModeSchema, type PolicyMode } from '../state/policy-mode.js';
import type { SessionState } from '../state/schema.js';
import { buildEnforcementError } from './blocked-result.js';
import type { OpenCodeGovernance } from './opencode-governance.js';
import { hydrate } from './tools/index.js';

const START_COMMAND_NAME = 'start';

type Registration = { dispose(): Promise<void> };
type CommandInvocation = {
  readonly sessionID: string;
  readonly prompt: { readonly text: string };
};

export interface StartCommandDeps {
  readonly governance: Pick<OpenCodeGovernance, 'startableRoot' | 'startRoot'>;
  /** Publishes the productive catalogue for the now ACTIVE location. */
  readonly publish: () => Promise<void>;
  /** Lifecycle admission and operation tracking owned by the plugin composition. */
  readonly guard: <T>(run: () => Promise<T>) => Promise<T>;
  readonly signal: AbortSignal;
}

export function registerStartCommand(
  ctx: Pick<Plugin.Context, 'command' | 'session'>,
  deps: StartCommandDeps,
): Promise<Registration> {
  return ctx.command.transform((editor) =>
    editor.add({
      name: START_COMMAND_NAME,
      description: `FlowGuard — start governance for this session (optional policy mode: ${POLICY_MODES.join(', ')}).`,
      execute: (input) => deps.guard(() => runStart(ctx, deps, input)),
    }),
  );
}

async function runStart(
  ctx: Pick<Plugin.Context, 'session'>,
  deps: StartCommandDeps,
  input: CommandInvocation,
): Promise<void> {
  const policyMode = parseStartArguments(input.prompt.text);
  const { directory } = await deps.governance.startableRoot(input.sessionID);
  const workflow = await hydrateWorkflow(input.sessionID, directory, policyMode, deps.signal);
  const actor = await resolveActorForPolicy(
    workflow.worktreeRoot,
    resolvePolicyFromSnapshot(workflow.state.policySnapshot),
  );
  const result = await deps.governance.startRoot(
    {
      sessionId: input.sessionID,
      directory,
      worktreeRoot: workflow.worktreeRoot,
      policyDigest: workflow.state.policySnapshot.hash,
    },
    toDecisionActor(actor),
  );
  await deps.publish();
  const status =
    result.kind === 'already_active'
      ? 'was already ACTIVE'
      : result.resumed
        ? 'is ACTIVE (an interrupted Start was completed)'
        : 'is ACTIVE';
  await ctx.session.synthetic({
    sessionID: input.sessionID,
    text: `FlowGuard governance ${status} for this session: ${workflow.state.policySnapshot.mode} policy, phase ${workflow.state.phase}.`,
    resume: false,
  });
}

/** `/start [policy mode]`; anything else is rejected, never guessed. */
export function parseStartArguments(text: string): PolicyMode | undefined {
  const value = text.trim();
  if (value === '') return undefined;
  const mode = PolicyModeSchema.safeParse(value);
  if (!mode.success)
    throw buildEnforcementError(
      'START_ARGUMENTS_INVALID',
      `Unsupported /start argument "${value.slice(0, 80)}".`,
    );
  return mode.data;
}

async function hydrateWorkflow(
  sessionId: string,
  directory: string,
  policyMode: PolicyMode | undefined,
  signal: AbortSignal,
): Promise<{ readonly worktreeRoot: string; readonly state: SessionState }> {
  const before = await resolveSessionAuthority({ root: directory, sessionId });
  if (before.status === 'unavailable') throw buildEnforcementError(before.code, before.reason);
  const { worktreeRoot } = before;
  // Hydrate reads only the session and worktree identity; a command has no message.
  const output = await hydrate.execute(
    { profileId: 'baseline', ...(policyMode === undefined ? {} : { policyMode }) },
    {
      sessionID: sessionId,
      messageID: '',
      agent: '',
      directory: worktreeRoot,
      worktree: worktreeRoot,
      abort: signal,
      metadata: () => {},
    },
  );
  const after = await resolveSessionAuthority({ root: directory, sessionId });
  if (after.status !== 'resolved' || after.worktreeRoot !== worktreeRoot)
    throw buildEnforcementError(
      'SESSION_DIR_NOT_FOUND',
      `Start could not establish the workflow state: ${typeof output === 'string' ? output : output.output}`,
    );
  return { worktreeRoot, state: after.state };
}

function toDecisionActor(actor: ActorInfo): GovernanceDecisionActor {
  return {
    actorId: actor.id,
    actorEmail: actor.email,
    actorDisplayName: actor.displayName ?? null,
    actorSource: actor.source,
    actorAssurance: actor.assurance,
  };
}
