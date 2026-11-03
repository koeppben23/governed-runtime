/** Root End orchestration outside the already-large native governance adapter. */
import { randomUUID } from 'node:crypto';
import {
  endRootGovernance,
  type GovernanceActivationStore,
  type GovernanceRootEnd,
  type GovernanceRootEndResult,
} from '../adapters/governance-activation.js';
import { blocked } from '../config/reasons.js';
import type {
  GovernanceActivationRevision,
  GovernanceDecisionActor,
} from '../state/governance-activation.js';
import { buildEnforcementError } from './blocked-result.js';

export interface EndRootContext {
  readonly store: GovernanceActivationStore;
  readonly withLock: <T>(sessionId: string, operation: () => Promise<T>) => Promise<T>;
  readonly rootDirectory: (sessionId: string) => Promise<string>;
  readonly signal: AbortSignal;
}

export type EndRootResult = Exclude<GovernanceRootEndResult, { kind: 'blocked' }>;

export type EndRootPrepare = (
  current: GovernanceActivationRevision,
  directory: string,
) => Promise<{
  readonly workflow: Pick<GovernanceRootEnd, 'worktreeRoot' | 'policyDigest'>;
  readonly actor: GovernanceDecisionActor;
}>;

export async function endRootActivation(
  context: EndRootContext,
  sessionId: string,
  prepare: EndRootPrepare,
): Promise<EndRootResult> {
  let actor: GovernanceDecisionActor | undefined;
  const result = await endRootGovernance(
    {
      store: context.store,
      withLock: (id, run) => context.withLock(id, run),
      authorize: async (input, current) => {
        if (context.signal.aborted || input.sessionId !== sessionId || actor === undefined)
          return blocked('GOVERNANCE_AUTHORITY_BLOCKED', {
            message: 'The governance adapter stopped or the End scope changed.',
          });
        if (input.action === 'begin_end')
          return { kind: 'authorized', decisionId: randomUUID(), source: 'host_command', actor };
        if (input.action === 'end' && current?.status === 'ending')
          return {
            kind: 'authorized',
            decisionId: current.decisionId,
            source: current.decisionSource,
            actor: current.decisionActor,
          };
        return blocked('GOVERNANCE_AUTHORITY_BLOCKED', {
          message: 'The End command authorizes only End and its completion.',
        });
      },
    },
    {
      sessionId,
      prepare: async (current) => {
        const directory = await context.rootDirectory(sessionId);
        const prepared = await prepare(current, directory);
        actor = prepared.actor;
        return { sessionId, directory, ...prepared.workflow };
      },
    },
  );
  if (result.kind === 'blocked') throw buildEnforcementError(result.code, result.reason);
  return result;
}
