/**
 * @module integration/governance-end-preconditions
 * @description Pure safe-closure preconditions for native EndGovernance.
 *
 * EndGovernance is not workflow finish/abort. It may close activation only when
 * the workflow is terminal (or never started), no system work is pending, no
 * reviewer or mutation execution can still produce authority, and every prior
 * audit operation is reconciled. A capacity lock is not implicitly released by
 * End; use the canonical RecoverCapacity or transport-settlement path first.
 */

import type { SessionState } from '../state/schema.js';
import { isTerminalPhase } from '../machine/topology.js';
import { hasUnresolvedMutationEpisodes } from '../state/evidence-mutation-episode.js';

export interface GovernanceEndBlocker {
  readonly code: string;
  readonly reason: string;
}

function blocker(code: string, reason: string): GovernanceEndBlocker {
  return { code, reason };
}

export function governanceEndBlocker(state: SessionState): GovernanceEndBlocker | null {
  return (
    workflowBlocker(state) ??
    reviewExecutionBlocker(state) ??
    mutationBlocker(state) ??
    auditBlocker(state)
  );
}

function workflowBlocker(state: SessionState): GovernanceEndBlocker | null {
  if (state.phase !== 'READY' && !isTerminalPhase(state.phase))
    return blocker(
      'GOVERNANCE_END_UNSAFE',
      `Workflow phase ${state.phase} is not terminal. Finish or abort the workflow before ending governance.`,
    );
  if (state.pendingSystemWork !== null)
    return blocker('GOVERNANCE_END_UNSAFE', 'Canonical system work is still pending.');
  if (state.error !== null && state.phase !== 'ABORTED')
    return blocker(
      'GOVERNANCE_END_UNSAFE',
      `Workflow error ${state.error.code} is unresolved. Abort the workflow or resolve the error first.`,
    );
  return null;
}

function reviewExecutionBlocker(state: SessionState): GovernanceEndBlocker | null {
  const assurance = state.reviewAssurance;
  if (assurance?.capacityLock)
    return blocker(
      'REVIEW_CAPACITY_REQUIRES_NEW_USER_COMMAND',
      `Review capacity lock ${assurance.capacityLock.code} is still active. Recover capacity or settle the reviewer outcome first.`,
    );
  if (assurance?.dispatches.some((dispatch) => dispatch.dispatchStatus === 'authorized'))
    return blocker(
      'GOVERNANCE_END_UNSAFE',
      'A reviewer dispatch is still authorized and may be executing.',
    );
  if (assurance?.attempts.some((attempt) => attempt.status === 'bound'))
    return blocker(
      'GOVERNANCE_END_UNSAFE',
      'A reviewer attempt is still bound to a host execution.',
    );
  return null;
}

function mutationBlocker(state: SessionState): GovernanceEndBlocker | null {
  return hasUnresolvedMutationEpisodes(state.mutationEpisodes, state.mutationEpisodeResolutions)
    ? blocker('GOVERNANCE_END_UNSAFE', 'A host mutation episode has an unresolved outcome.')
    : null;
}

function auditBlocker(state: SessionState): GovernanceEndBlocker | null {
  return state.pendingAuditOperations.some((operation) => operation.status !== 'reconciled')
    ? blocker('GOVERNANCE_END_UNSAFE', 'Committed audit operations are not reconciled yet.')
    : null;
}
