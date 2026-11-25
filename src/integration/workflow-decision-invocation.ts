/** Scoped native decision authority. No process-wide intent cache or prompt-derived permission. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import {
  WorkflowDecisionOperation,
  type GovernanceActivationRevision,
} from '../state/governance-activation.js';
import type { SessionState } from '../state/schema.js';
import { ReviewVerdict } from '../state/evidence.js';
import { computeStateDigest } from './audit-outbox.js';
import { hashText } from '../shared/hashing.js';
import { buildEnforcementError } from './blocked-result.js';

/** The one decision-argument contract shared by native commands and model tools. */
export const DecisionArgsSchema = z
  .object({ verdict: ReviewVerdict, rationale: z.string().default('') })
  .strict();
export type DecisionArgs = z.infer<typeof DecisionArgsSchema>;

export interface DecisionInvocation {
  readonly operation: WorkflowDecisionOperation;
  readonly assertScopeCurrent: () => Promise<void>;
  committed: boolean;
}
export interface DecisionProbe {
  readonly context: { readonly sessionID: string; readonly worktree: string };
  readonly state: SessionState;
  readonly verdict: ReviewVerdict;
  readonly rationale: string;
}
const current = new AsyncLocalStorage<DecisionInvocation>();

export function createDecisionOperation(
  activation: GovernanceActivationRevision,
  state: SessionState,
  args: DecisionArgs,
  source: WorkflowDecisionOperation['source'],
): WorkflowDecisionOperation {
  return WorkflowDecisionOperation.parse({
    sessionId: activation.sessionId,
    rootSessionId: activation.rootSessionId,
    activationId: activation.activationId,
    generation: activation.generation,
    directory: activation.directory,
    worktreeRoot: activation.worktreeRoot,
    policyDigest: activation.policyDigest,
    operationId: randomUUID(),
    source,
    stateDigest: computeStateDigest(state),
    verdict: args.verdict,
    rationaleDigest: hashText(args.rationale),
  });
}

export function runWithDecisionInvocation<T>(
  operation: WorkflowDecisionOperation,
  assertScopeCurrent: () => Promise<void>,
  run: () => Promise<T>,
): Promise<T> {
  return current.run(
    { operation: WorkflowDecisionOperation.parse(operation), assertScopeCurrent, committed: false },
    run,
  );
}

/** The probe is available to explicit component fixtures; production never synthesizes authority. */
export function readDecisionInvocation(_probe: DecisionProbe): DecisionInvocation | undefined {
  return current.getStore();
}

export async function verifyDecisionInvocation(
  invocation: DecisionInvocation,
  probe: DecisionProbe,
): Promise<void> {
  const op = invocation.operation;
  if (
    invocation.committed ||
    op.sessionId !== probe.context.sessionID ||
    op.rootSessionId !== op.sessionId ||
    op.worktreeRoot !== probe.context.worktree ||
    op.policyDigest !== probe.state.policySnapshot.hash ||
    op.stateDigest !== computeStateDigest(probe.state) ||
    op.verdict !== probe.verdict ||
    op.rationaleDigest !== hashText(probe.rationale)
  )
    throw buildEnforcementError(
      'HUMAN_DECISION_REQUIRED',
      'The explicit decision operation is stale, consumed or bound to another action/subject.',
    );
  await invocation.assertScopeCurrent();
}
