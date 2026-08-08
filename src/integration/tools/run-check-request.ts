/** Request validation and candidate resolution for flowguard_run_check. */

import { Command, isCommandAllowed } from '../../machine/commands.js';
import { evaluateValidationEvidence } from '../../machine/validation-evidence.js';
import type {
  VerificationCandidate,
  VerificationCandidateKind,
} from '../../state/discovery-schemas.js';
import type { SessionState } from '../../state/schema.js';
import { formatBlocked } from './helpers.js';

export type RunCheckGuard = { readonly checkId: string; readonly candidate: VerificationCandidate };

export function validateRunCheckRequest(
  kind: VerificationCandidateKind,
  candidateId: string | undefined,
  state: SessionState,
): string | RunCheckGuard {
  if (!isCommandAllowed(state.phase, Command.VALIDATE)) {
    return formatBlocked('COMMAND_NOT_ALLOWED', { command: '/run_check', phase: state.phase });
  }
  const phaseBlock = validateExecutionPhase(state);
  if (phaseBlock) return phaseBlock;
  const activeChecksBlock = blockWhenNoActiveChecks(state);
  if (activeChecksBlock) return activeChecksBlock;
  const candidate = findCandidate(state.verificationCandidates ?? [], kind, candidateId);
  if (!candidate) {
    return formatBlocked('CHECK_KIND_NOT_AVAILABLE', {
      kind,
      ...(candidateId ? { candidateId } : {}),
      available: state.verificationCandidates?.map((entry) => entry.kind).join(', ') || 'none',
    });
  }
  if (!state.activeChecks.includes(kind)) {
    return formatBlocked('CHECK_NOT_ACTIVE', {
      checkId: kind,
      activeChecks: state.activeChecks.join(', '),
    });
  }
  return { checkId: kind, candidate };
}

function validateExecutionPhase(state: SessionState): string | null {
  if (state.phase === 'VALIDATION' && !state.plan) {
    return formatBlocked('PLAN_REQUIRED', { action: 'baseline validation' });
  }
  if (state.phase === 'IMPL_VALIDATION' && !state.implementation) {
    return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
  }
  return null;
}

function findCandidate(
  candidates: readonly VerificationCandidate[],
  kind: VerificationCandidateKind,
  candidateId: string | undefined,
): VerificationCandidate | undefined {
  if (!candidateId) return candidates.find((candidate) => candidate.kind === kind);
  return candidates.find(
    (candidate) => candidate.candidateId === candidateId && candidate.kind === kind,
  );
}

function blockWhenNoActiveChecks(state: SessionState): string | null {
  if (state.activeChecks.length > 0) return null;
  const evidence = evaluateValidationEvidence(state);
  return evidence.blocked && evidence.code !== null
    ? formatBlocked(evidence.code)
    : formatBlocked('NO_ACTIVE_CHECKS');
}
