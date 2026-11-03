/**
 * Native RecoverCapacity and EndGovernance commands.
 *
 * RecoverCapacity releases only the two host-capacity closures whose terminal
 * lineage is durable; it never reopens an obligation, rewrites an attempt or
 * clears an unknown-outcome fence. EndGovernance closes activation through the
 * canonical journal only after safe workflow closure and audit reconciliation.
 */
import { randomUUID } from 'node:crypto';
import type { Plugin } from '@opencode/plugin';
import {
  appendAuditEventAlreadyLocked,
  readAuditTrail,
  withAuditTrailLock,
} from '../adapters/persistence-audit.js';
import { resolveActorForPolicy } from '../adapters/actor-context.js';
import { resolveSessionAuthority } from '../adapters/session-authority.js';
import { verifyChain } from '../audit/integrity.js';
import { resolvePolicyFromSnapshot } from '../config/policy-snapshot.js';
import {
  NATIVE_END_GOVERNANCE_COMMAND,
  NATIVE_RECOVER_CAPACITY_COMMAND,
} from '../shared/flowguard-identifiers.js';
import {
  toGovernanceDecisionActor,
  type GovernanceActivationRevision,
} from '../state/governance-activation.js';
import { computeStateDigest } from './audit-outbox.js';
import { buildEnforcementError } from './blocked-result.js';
import { governanceEndBlocker } from './governance-end-preconditions.js';
import type { ActiveGovernanceScope, OpenCodeGovernance } from './opencode-governance.js';
import { reconcilePendingAuditOperations } from './plugin-audit-reconcile.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import {
  capacityRecoveryAuditIntents,
  recoverableCapacityTarget,
  releaseTerminalCapacityLock,
} from './review/dispatch/native-review-settlement.js';

interface GovernanceLifecycleCommandDeps {
  readonly governance: Pick<OpenCodeGovernance, 'endRoot'>;
  readonly guard: <T>(run: () => Promise<T>) => Promise<T>;
  readonly invoke: <T>(
    sessionId: string,
    run: (entry: {
      readonly runtime: FlowGuardPluginRuntime;
      readonly scope: ActiveGovernanceScope;
    }) => Promise<T>,
    required?: boolean,
  ) => Promise<T | undefined>;
}

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];

export function addGovernanceLifecycleCommands(
  ctx: Plugin.Context,
  deps: GovernanceLifecycleCommandDeps,
  editor: CommandEditor,
): void {
  editor.add({
    name: NATIVE_RECOVER_CAPACITY_COMMAND,
    description:
      'FlowGuard — explicitly release a terminal reviewer step-budget or output-limit capacity lock after its durable lineage is verified.',
    execute: (input) => deps.guard(() => executeRecoverCapacity(ctx, deps, input.sessionID)),
  });
  editor.add({
    name: NATIVE_END_GOVERNANCE_COMMAND,
    description:
      'FlowGuard — end opt-in governance for this root session after safe workflow closure; this is not /finish or /abort.',
    execute: (input) => deps.guard(() => executeEndGovernance(ctx, deps, input.sessionID)),
  });
}

async function executeRecoverCapacity(
  ctx: Plugin.Context,
  deps: GovernanceLifecycleCommandDeps,
  sessionID: string,
): Promise<void> {
  await deps.invoke(
    sessionID,
    async ({ runtime, scope }) => {
      if (scope.sessionId !== scope.root.sessionId)
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'A delegated child cannot recover root reviewer capacity.',
        );
      const authority = await runtime.ws.resolveSessionAuthority(sessionID);
      if (authority.status !== 'resolved')
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'Review capacity authority is unavailable.',
        );
      const target = recoverableCapacityTarget(authority.state);
      if (target === null)
        throw capacityFailure(authority.state.reviewAssurance?.capacityLock?.code);
      const actor = await resolveActorForPolicy(
        authority.worktreeRoot,
        resolvePolicyFromSnapshot(authority.state.policySnapshot),
      );
      const operation = {
        operationId: randomUUID(),
        source: 'host_command',
        sessionId: scope.root.sessionId,
        rootSessionId: scope.root.rootSessionId,
        activationId: scope.root.activationId,
        generation: scope.root.generation,
        directory: scope.root.directory,
        worktreeRoot: scope.root.worktreeRoot,
        policyDigest: scope.root.policyDigest,
        stateDigest: computeStateDigest(authority.state),
        obligationId: target.lock.obligationId,
        code: target.lock.code,
      };
      await runtime.ws.updateReviewAssurance(
        authority.sessDir,
        (state) => releaseTerminalCapacityLock(state, target),
        capacityRecoveryAuditIntents(target, operation, actor),
      );
      const reconciliation = await reconcilePendingAuditOperations(
        runtime.auditDeps,
        sessionID,
        NATIVE_RECOVER_CAPACITY_COMMAND,
      );
      if (reconciliation?.block)
        throw buildEnforcementError(
          reconciliation.code,
          `The capacity lock was released, but its audit is unconfirmed. ${reconciliation.reason}`,
        );
      await presentLifecycle(
        ctx,
        sessionID,
        `Review capacity lock ${target.lock.code} was released for obligation ${target.lock.obligationId}. The obligation remains blocked; run a new explicit review command to submit a fresh review.`,
        'capacity status',
      );
    },
    true,
  );
}

function capacityFailure(code: string | undefined): Error {
  if (code === undefined)
    return buildEnforcementError(
      'REVIEW_CAPACITY_NOT_LOCKED',
      'No recoverable terminal reviewer capacity lock exists.',
    );
  return buildEnforcementError(
    'REVIEW_CAPACITY_RECOVERY_UNSAFE',
    code === 'REVIEWER_EXECUTION_OUTCOME_UNKNOWN'
      ? 'An unknown reviewer outcome is recovered only through the typed reviewRecovery "retry_transport" path, not RecoverCapacity.'
      : `The capacity lock ${code} has no exact recoverable terminal lineage.`,
  );
}

async function executeEndGovernance(
  ctx: Plugin.Context,
  deps: GovernanceLifecycleCommandDeps,
  sessionID: string,
): Promise<void> {
  const result = await deps.governance.endRoot(sessionID, async (current, directory) => {
    const authority = await resolveSessionAuthority({ root: directory, sessionId: sessionID });
    if (authority.status === 'unavailable')
      throw buildEnforcementError(authority.code, authority.reason);
    if (authority.status !== 'resolved')
      throw buildEnforcementError(
        'GOVERNANCE_AUTHORITY_BLOCKED',
        'EndGovernance cannot verify the workflow state.',
      );
    if (
      authority.worktreeRoot !== current.worktreeRoot ||
      authority.state.policySnapshot.hash !== current.policyDigest
    )
      throw buildEnforcementError(
        'GOVERNANCE_AUTHORITY_BLOCKED',
        'EndGovernance no longer matches the active worktree or frozen policy.',
      );
    if (current.status === 'active') {
      await deps.invoke(
        sessionID,
        async ({ runtime, scope }) => {
          if (scope.sessionId !== scope.root.sessionId)
            throw buildEnforcementError(
              'GOVERNANCE_AUTHORITY_BLOCKED',
              'A delegated child cannot end root governance.',
            );
          const reconciliation = await reconcilePendingAuditOperations(
            runtime.auditDeps,
            sessionID,
            NATIVE_END_GOVERNANCE_COMMAND,
          );
          if (reconciliation?.block)
            throw buildEnforcementError(reconciliation.code, reconciliation.reason);
          await assertSafeEnd(sessionID, directory);
        },
        true,
      );
    } else {
      await assertSafeEnd(sessionID, directory);
    }
    const fresh = await resolveSessionAuthority({ root: directory, sessionId: sessionID });
    if (fresh.status !== 'resolved')
      throw buildEnforcementError(
        'GOVERNANCE_AUTHORITY_BLOCKED',
        'EndGovernance lost its workflow authority during preparation.',
      );
    const actor = toGovernanceDecisionActor(
      await resolveActorForPolicy(
        fresh.worktreeRoot,
        resolvePolicyFromSnapshot(fresh.state.policySnapshot),
      ),
    );
    return {
      workflow: {
        worktreeRoot: fresh.worktreeRoot,
        policyDigest: fresh.state.policySnapshot.hash,
      },
      actor,
    };
  });
  if (result.record === null)
    throw buildEnforcementError(
      'GOVERNANCE_NOT_ACTIVE',
      'No governance activation exists for this session; there is nothing to end.',
    );
  await recordEndAudit(sessionID, result.record);
  await presentLifecycle(
    ctx,
    sessionID,
    result.kind === 'ended'
      ? `FlowGuard governance is INACTIVE for this session${result.resumed ? ' (an interrupted End was completed)' : ''}.`
      : 'FlowGuard governance was already INACTIVE for this session.',
    'End status',
  );
}

async function assertSafeEnd(sessionId: string, directory: string): Promise<void> {
  const fresh = await resolveSessionAuthority({ root: directory, sessionId });
  if (fresh.status !== 'resolved')
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      'EndGovernance cannot read the workflow state for safe closure.',
    );
  const blocker = governanceEndBlocker(fresh.state);
  if (blocker !== null) throw buildEnforcementError(blocker.code, blocker.reason);
}

async function recordEndAudit(
  sessionId: string,
  record: GovernanceActivationRevision,
): Promise<void> {
  try {
    const resolved = await resolveSessionAuthority({
      root: record.worktreeRoot,
      sessionId,
    });
    if (resolved.status !== 'resolved')
      throw buildEnforcementError(
        'GOVERNANCE_AUTHORITY_BLOCKED',
        'EndGovernance audit cannot resolve its workflow binding.',
      );
    if (
      resolved.state.policySnapshot.hash !== record.policyDigest ||
      resolved.state.flowguardSessionId !== resolved.state.id
    )
      throw buildEnforcementError(
        'GOVERNANCE_AUTHORITY_BLOCKED',
        'EndGovernance audit is bound to another workflow or policy.',
      );
    await withAuditTrailLock(resolved.sessDir, async () => {
      const events = await readAuditTrail(resolved.sessDir);
      if (!verifyChain(events).valid)
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'EndGovernance audit trail fails chain verification.',
        );
      const prior = events.find((event) => event.id === record.decisionId);
      const actor = record.decisionActor;
      await appendAuditEventAlreadyLocked(resolved.sessDir, {
        id: record.decisionId,
        flowguardSessionId: resolved.state.flowguardSessionId,
        hostSessionId: record.sessionId,
        phase: prior?.phase ?? resolved.state.phase,
        event: 'governance:ended',
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
  } catch (error) {
    throw buildEnforcementError(
      'GOVERNANCE_AUTHORITY_BLOCKED',
      `Governance is durably INACTIVE but its End audit is unconfirmed; retry /${NATIVE_END_GOVERNANCE_COMMAND} without rehydrating. ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function presentLifecycle(
  ctx: Plugin.Context,
  sessionID: string,
  text: string,
  step: string,
): Promise<void> {
  try {
    await ctx.session.synthetic({ sessionID, text, resume: false });
  } catch (error) {
    console.warn(`[FlowGuard] ${step} presentation failed after the durable transition.`, error);
  }
}
