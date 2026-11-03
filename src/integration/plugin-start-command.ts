/**
 * Native `/start`: the host command channel opts exactly one root session into
 * governance. Sessions stay INACTIVE and untouched until this command runs. The
 * channel cannot distinguish operator UI from SDK or agent callers, so the
 * decision is recorded as `host_command` with the canonically resolved actor and
 * never as a verified human (ADR-010 D3).
 *
 * One activation lock covers journal preflight, workflow preparation and Start
 * completion. ACTIVE/ACTIVATING reuse only their bound state, never rehydrate.
 * Successful authority is audited idempotently before best-effort presentation.
 */
import type { Plugin } from '@opencode/plugin';
import * as path from 'node:path';
import { readConfig } from '../adapters/persistence-config.js';
import { isAssuranceAtLeast } from '../shared/actor-assurance.js';
import { hashText } from '../shared/hashing.js';
import { canonicalJsonStringify } from '../shared/canonical-json.js';
import { resolveActorForPolicy } from '../adapters/actor-context.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { freezePolicySnapshot, resolvePolicyFromSnapshot } from '../config/policy-snapshot.js';
import { NATIVE_START_COMMAND } from '../shared/flowguard-identifiers.js';
import {
  toGovernanceDecisionActor,
  type GovernanceDecisionActor,
  type GovernanceActivationRevision,
} from '../state/governance-activation.js';
import { POLICY_MODES, PolicyModeSchema, type PolicyMode } from '../state/policy-mode.js';
import type { SessionState } from '../state/schema.js';
import { buildEnforcementError } from './blocked-result.js';
import type { OpenCodeGovernance } from './opencode-governance.js';
import { runAudit } from './plugin-audit.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { TOOL_FLOWGUARD_HYDRATE } from './tool-names.js';
import { hydrate, resolveHydratePolicy } from './tools/index.js';
import { FlowGuardGovernance, type AutonomousStartRequest } from './opencode-governance-rpc.js';
import { addDecisionCommands } from './plugin-decision-command.js';
import { addGovernanceLifecycleCommands } from './plugin-governance-lifecycle-command.js';
import { addCheckCommand } from './plugin-check-command.js';
import type { ActiveGovernanceScope } from './opencode-governance.js';
import {
  appendAuditEventAlreadyLocked,
  readAuditTrail,
  withAuditTrailLock,
} from '../adapters/persistence-audit.js';
import { verifyChain } from '../audit/integrity.js';
import { buildGateNotice } from '../presentation/gate-notice.js';

type Registration = { dispose(): Promise<void> };
type CommandInvocation = {
  readonly sessionID: string;
  readonly prompt: { readonly text: string };
};

type StartWorkflow = {
  readonly worktreeRoot: string;
  readonly state: SessionState;
  readonly report: readonly string[];
  readonly hydration: { readonly args: Record<string, unknown>; readonly output: string } | null;
};

export interface StartCommandDeps {
  readonly governance: Pick<
    OpenCodeGovernance,
    | 'startRoot'
    | 'confirmActivationAudit'
    | 'endRoot'
    | 'assertScopeCurrent'
    | 'assertActivationAuditConfirmed'
  >;
  /** Publishes the productive catalogue for the now ACTIVE location. */
  readonly publish: () => Promise<void>;
  /** Lifecycle admission and operation tracking owned by the plugin composition. */
  readonly guard: <T>(run: () => Promise<T>) => Promise<T>;
  /** Runs inside the verified ACTIVE runtime of a session (required scope). */
  readonly invoke: <T>(
    sessionId: string,
    action: (entry: {
      readonly runtime: FlowGuardPluginRuntime;
      readonly scope: ActiveGovernanceScope;
    }) => Promise<T>,
    required?: boolean,
    options?: { readonly allowPendingActivationAudit?: boolean },
  ) => Promise<T | undefined>;
  readonly signal: AbortSignal;
}

export async function registerStartCommands(
  ctx: Plugin.Context,
  deps: StartCommandDeps,
  registrations: Registration[],
): Promise<void> {
  registrations.push(await registerStartCommand(ctx, deps));
  registrations.push(await registerAutonomousStart(ctx, deps));
}

function registerStartCommand(ctx: Plugin.Context, deps: StartCommandDeps): Promise<Registration> {
  return ctx.command.transform((editor) => {
    editor.add({
      name: NATIVE_START_COMMAND,
      description: `FlowGuard — start governance for this session (optional policy mode: ${POLICY_MODES.join(', ')}).`,
      execute: (input) =>
        deps.guard(async () => {
          await runStart(ctx, deps, input);
        }),
    });
    addDecisionCommands(ctx, deps, editor);
    addGovernanceLifecycleCommands(ctx, deps, editor);
    addCheckCommand(ctx, deps, editor);
  });
}

/** Dedicated native operation, never installed as a model tool or prompt trigger. */
function registerAutonomousStart(
  ctx: Plugin.Context,
  deps: StartCommandDeps,
): Promise<Registration> {
  return ctx.rpc.register(FlowGuardGovernance, {
    StartGovernance: (request) =>
      deps.guard(async () => {
        try {
          return await runStart(
            ctx,
            deps,
            {
              sessionID: request.sessionID,
              prompt: { text: request.policyMode ?? '' },
            },
            { ...request, directory: ctx.location.directory },
          );
        } catch (error) {
          return {
            kind: 'blocked' as const,
            code:
              error instanceof Error && 'code' in error && typeof error.code === 'string'
                ? error.code
                : 'GOVERNANCE_AUTHORITY_BLOCKED',
            reason: error instanceof Error ? error.message : String(error),
          };
        }
      }),
  });
}

async function runStart(
  ctx: Pick<Plugin.Context, 'session'>,
  deps: StartCommandDeps,
  input: CommandInvocation,
  autonomous?: AutonomousStartRequest & { readonly directory: string },
) {
  const policyMode = parseStartArguments(input.prompt.text);
  let workflow: StartWorkflow | undefined;
  const result = await deps.governance.startRoot(
    input.sessionID,
    async (current, directory) => {
      let authorizedActor =
        autonomous === undefined
          ? undefined
          : await authorizeAutonomousStart(autonomous, directory, current);
      workflow =
        current?.status === 'active' || current?.status === 'activating'
          ? await readBoundWorkflow(input.sessionID, directory, current, policyMode)
          : await hydrateWorkflow(input.sessionID, directory, policyMode, deps.signal);
      if (autonomous !== undefined) {
        if (workflow.state.policySnapshot.hash !== autonomous.policyDigest)
          throw buildEnforcementError(
            'GOVERNANCE_AUTHORITY_BLOCKED',
            'Autonomous Start policy changed during preparation.',
          );
        authorizedActor = await authorizeAutonomousStart(autonomous, directory, current);
      }
      const actor = await resolveStartActor(current, workflow, authorizedActor);
      return {
        workflow: {
          worktreeRoot: workflow.worktreeRoot,
          policyDigest: workflow.state.policySnapshot.hash,
        },
        actor,
      };
    },
    autonomous === undefined ? 'host_command' : 'autonomous',
  );
  if (!workflow)
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'Start did not resolve its workflow binding.',
    );
  await confirmCommittedStartAudits(deps, input.sessionID, workflow, result.record);
  await presentCommittedStart(() => deps.publish(), 'catalogue', input.sessionID);
  const status =
    result.kind === 'already_active'
      ? 'was already ACTIVE'
      : result.resumed
        ? 'is ACTIVE (an interrupted Start was completed)'
        : 'is ACTIVE';
  const text = [
    `FlowGuard governance ${status} for this session: ${workflow.state.policySnapshot.mode} policy, phase ${workflow.state.phase}.`,
    ...workflow.report,
  ].join('\n\n');
  await presentCommittedStart(
    () =>
      ctx.session.synthetic({
        sessionID: input.sessionID,
        text,
        resume: false,
      }),
    'status report',
    input.sessionID,
  );
  return { kind: result.kind, activationId: result.record.activationId };
}

/** Runs under the canonical activation lock, before hydrate can have effects. */
async function authorizeAutonomousStart(
  request: AutonomousStartRequest & { readonly directory: string },
  directory: string,
  current: GovernanceActivationRevision | null,
): Promise<GovernanceDecisionActor> {
  const reject = (reason: string): never => {
    throw buildEnforcementError('GOVERNANCE_AUTHORITY_BLOCKED', reason);
  };
  if (path.resolve(request.directory) !== directory)
    reject('Autonomous Start must target a root in this host location.');
  const before = await resolveSessionAuthority({ root: directory, sessionId: request.sessionID });
  if (before.status === 'unavailable') return reject(before.reason);
  if (before.worktreeRoot !== request.worktreeRoot)
    reject('Autonomous Start names a foreign worktree.');
  const config = await readConfig(before.worktreeRoot);
  const permission = config.governance.autonomousActivation;
  if (!permission.enabled) reject('Autonomous activation is disabled in flowguard.json.');
  const resolved = await resolveHydratePolicy(
    before.status === 'resolved' ? before.state : null,
    config,
    request.policyMode === undefined ? {} : { policyMode: request.policyMode },
  );
  const snapshot =
    before.status === 'resolved'
      ? before.state.policySnapshot
      : freezePolicySnapshot(resolved.policyResolution, new Date().toISOString(), hashText);
  if (snapshot.hash !== request.policyDigest)
    reject('Autonomous Start names a foreign policy digest.');
  const actor = toGovernanceDecisionActor(
    await resolveActorForPolicy(before.worktreeRoot, resolved.policy),
  );
  if (!isAssuranceAtLeast(actor.actorAssurance, permission.minimumActorAssurance))
    reject('Autonomous Start actor assurance is below the configured minimum.');
  assertPendingActor(current, actor);
  return actor;
}

function assertPendingActor(
  current: GovernanceActivationRevision | null,
  actor: GovernanceDecisionActor,
): void {
  if (
    current?.status === 'activating' &&
    canonicalJsonStringify(current.decisionActor) !== canonicalJsonStringify(actor)
  )
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'Autonomous Start cannot resume another actor’s pending decision.',
    );
}

async function resolveStartActor(
  current: GovernanceActivationRevision | null,
  workflow: StartWorkflow,
  authorizedActor: GovernanceDecisionActor | undefined,
): Promise<GovernanceDecisionActor> {
  if (current?.status === 'active' || current?.status === 'activating')
    return current.decisionActor;
  return (
    authorizedActor ??
    toGovernanceDecisionActor(
      await resolveActorForPolicy(
        workflow.worktreeRoot,
        resolvePolicyFromSnapshot(workflow.state.policySnapshot),
      ),
    )
  );
}

async function readBoundWorkflow(
  sessionId: string,
  directory: string,
  current: GovernanceActivationRevision,
  policyMode: PolicyMode | undefined,
): Promise<StartWorkflow> {
  const resolution = await resolveSessionAuthority({ root: directory, sessionId });
  if (
    resolution.status !== 'resolved' ||
    resolution.worktreeRoot !== current.worktreeRoot ||
    directory !== current.directory ||
    resolution.state.policySnapshot.hash !== current.policyDigest ||
    (policyMode !== undefined && policyMode !== resolution.state.policySnapshot.mode)
  )
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'Start cannot reuse a missing or differently bound workflow; no hydration was attempted.',
    );
  const notice = buildGateNotice(
    resolution.state.policySnapshot.effectiveGateBehavior,
    resolution.state.policySnapshot.mode,
  );
  return {
    worktreeRoot: resolution.worktreeRoot,
    state: resolution.state,
    report: notice === null ? [] : [notice],
    hydration: null,
  };
}

async function presentCommittedStart(
  run: () => Promise<unknown>,
  step: string,
  sessionId: string,
): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.warn(
      `[FlowGuard] Governance is durably ACTIVE for ${sessionId}; ${step} failed. Query status or retry /start without rehydrating.`,
      error,
    );
  }
}

/**
 * The activation commit is already durable, so both audits are attempted before
 * any failure is reported. The activation audit is the authority-critical one
 * and must not be skipped because a hydrate/preparation audit failed.
 */
async function confirmCommittedStartAudits(
  deps: StartCommandDeps,
  sessionId: string,
  workflow: StartWorkflow,
  record: GovernanceActivationRevision,
): Promise<void> {
  let preparationFailure: unknown;
  try {
    await auditWorkflowPreparation(deps, sessionId, workflow);
  } catch (error) {
    preparationFailure = error;
  }
  await recordActivationAudit(deps, workflow, record);
  if (preparationFailure !== undefined)
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'Governance is durably ACTIVE and its activation audit is confirmed, but the hydrate preparation audit is unconfirmed. ' +
        (preparationFailure instanceof Error
          ? preparationFailure.message
          : String(preparationFailure)),
    );
}

/** The activation ID is the commit identity; the existing audit writer enforces
 * exactly-once delivery and rejects different content under that identity. */
async function recordActivationAudit(
  deps: StartCommandDeps,
  workflow: StartWorkflow,
  record: GovernanceActivationRevision,
): Promise<void> {
  try {
    const resolved = await resolveSessionAuthority({
      root: record.worktreeRoot,
      sessionId: record.sessionId,
    });
    if (
      resolved.status !== 'resolved' ||
      resolved.state.flowguardSessionId !== workflow.state.flowguardSessionId ||
      resolved.state.policySnapshot.hash !== record.policyDigest
    )
      throw buildEnforcementError(
        'GOVERNANCE_AUTHORITY_BLOCKED',
        'Activation audit cannot resolve its committed workflow binding.',
      );
    await withAuditTrailLock(resolved.sessDir, async () => {
      const events = await readAuditTrail(resolved.sessDir);
      if (!verifyChain(events).valid)
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'Activation audit trail fails chain verification.',
        );
      const prior = events.find((event) => event.id === record.activationId);
      const actor = record.decisionActor;
      await appendAuditEventAlreadyLocked(resolved.sessDir, {
        id: record.activationId,
        flowguardSessionId: workflow.state.flowguardSessionId,
        hostSessionId: record.sessionId,
        phase: prior?.phase ?? workflow.state.phase,
        event: 'governance:activated',
        occurredAt: prior?.occurredAt ?? new Date().toISOString(),
        actor: 'machine',
        actorInfo: {
          id: actor.actorId,
          email: actor.actorEmail,
          displayName: actor.actorDisplayName,
          source: actor.actorSource,
          assurance: actor.actorAssurance,
        },
        detail: {
          activationId: record.activationId,
          decisionId: record.decisionId,
          channel: record.decisionSource,
          generation: record.generation,
          revision: record.revision,
          rootSessionId: record.rootSessionId,
          directory: record.directory,
          worktreeRoot: record.worktreeRoot,
          policyDigest: record.policyDigest,
        },
      });
    });
    await deps.governance.confirmActivationAudit(record);
  } catch (error) {
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      `Governance is durably ACTIVE but activation audit is unconfirmed; retry /start without rehydrating. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
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

/**
 * The hydrate call the former template made was audited by the tool after-hook:
 * tool call, `lifecycle:session_created` and the committed semantic operations.
 * Start runs the same canonical audit inside the now ACTIVE runtime; a blocking
 * audit outcome fails the command visibly.
 */
async function auditWorkflowPreparation(
  deps: StartCommandDeps,
  sessionId: string,
  workflow: StartWorkflow,
): Promise<void> {
  await deps.invoke(
    sessionId,
    ({ runtime }) =>
      runtime.ws.runSerializedForSession(sessionId, async () => {
        const outcome =
          workflow.hydration === null
            ? await reconcilePendingAuditOperations(
                runtime.auditDeps,
                sessionId,
                NATIVE_START_COMMAND,
              )
            : await runAudit(
                runtime.auditDeps,
                TOOL_FLOWGUARD_HYDRATE,
                workflow.hydration.args,
                { title: '', output: workflow.hydration.output, metadata: {} },
                sessionId,
              );
        if (outcome?.block) throw buildEnforcementError(outcome.code, outcome.reason);
      }),
    true,
    { allowPendingActivationAudit: true },
  );
}

async function hydrateWorkflow(
  sessionId: string,
  directory: string,
  policyMode: PolicyMode | undefined,
  signal: AbortSignal,
): Promise<StartWorkflow> {
  const before = await resolveSessionAuthority({ root: directory, sessionId });
  if (before.status === 'unavailable') throw buildEnforcementError(before.code, before.reason);
  const { worktreeRoot } = before;
  // Hydrate reads only the session and worktree identity; a command has no message.
  const args = { profileId: 'baseline', ...(policyMode === undefined ? {} : { policyMode }) };
  const output = await hydrate.execute(args, {
    sessionID: sessionId,
    messageID: '',
    agent: '',
    directory: worktreeRoot,
    worktree: worktreeRoot,
    abort: signal,
    metadata: () => {},
  });
  const text = typeof output === 'string' ? output : output.output;
  const hydrated = jsonHead(text);
  // Hydrate reports blocked/error outcomes as a tool result, not an exception.
  // A state that was already prepared must never turn that failure into Start.
  if (hydrated.error === true || hydrated.status !== 'ok')
    throw buildEnforcementError(
      typeof hydrated.code === 'string' ? hydrated.code : 'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      `Start did not hydrate the workflow: ${typeof hydrated.message === 'string' ? hydrated.message : text}`,
    );
  const after = await resolveSessionAuthority({ root: directory, sessionId });
  if (after.status !== 'resolved' || after.worktreeRoot !== worktreeRoot)
    throw buildEnforcementError(
      'SESSION_DIR_NOT_FOUND',
      `Start could not establish the workflow state: ${text}`,
    );
  return {
    worktreeRoot,
    state: after.state,
    report: hydrateReport(text, after.state),
    hydration: { args, output: text },
  };
}

/**
 * The hydrate presentation the former prompt template printed verbatim. An
 * auto-approve gate notice is required report content; an unreadable report or
 * missing notice fails before activation. Post-commit delivery is best-effort,
 * and an ACTIVE retry reconstructs the notice without rehydration.
 */
function hydrateReport(output: string, state: SessionState): readonly string[] {
  const record = jsonHead(output);
  const presentation = isRecord(record.presentation) ? record.presentation.markdown : undefined;
  const markdown = typeof presentation === 'string' ? presentation : undefined;
  const notice = typeof record.gateNotice === 'string' ? record.gateNotice : undefined;
  if (state.policySnapshot.effectiveGateBehavior === 'auto_approve' && notice === undefined)
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'Start cannot report the auto-approve gate notice of the hydrated workflow.',
    );
  return [
    ...(markdown === undefined ? [] : [markdown]),
    ...(notice === undefined || markdown?.includes(notice) === true ? [] : [notice]),
  ];
}

/** Tool results carry one JSON head line; an unreadable head yields no fields. */
function jsonHead(output: string): Record<string, unknown> {
  try {
    const head: unknown = JSON.parse(output.split('\n', 1)[0] ?? '');
    return isRecord(head) ? head : {};
  } catch {
    return {};
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
