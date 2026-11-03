/** Opt-in lifecycle topology. Workflow phases never imply activation or termination. */
import type {
  GovernanceActivationAction,
  GovernanceActivationRevision,
} from '../state/governance-activation.js';

export function isGovernanceActivationTransition(
  previous: GovernanceActivationRevision | null,
  next: GovernanceActivationRevision,
): boolean {
  if (!hasCoherentSource(next)) return false;
  if (previous === null) {
    return isInitialEnrollment(next);
  }
  if (next.decisionId === previous.decisionId && !sameDecision(previous, next)) return false;
  if (previous.parentDispatch !== null) return isDelegationContinuation(previous, next);
  if (!isNextRootRevision(previous, next)) return false;
  if (previous.status === 'inactive') {
    return isReactivation(previous, next);
  }
  return sameActivation(previous, next) && isRootLifecycleStep(previous, next);
}

/** Start and End decisions each span two revisions under one decision id. */
function isRootLifecycleStep(
  previous: GovernanceActivationRevision,
  next: GovernanceActivationRevision,
): boolean {
  switch (previous.status) {
    case 'inactive':
      return false;
    case 'activating':
      return next.status === 'active' && next.decisionId === previous.decisionId;
    case 'active':
      return next.status === 'ending' && next.decisionId !== previous.decisionId;
    case 'ending':
      return next.status === 'inactive' && next.decisionId === previous.decisionId;
  }
}

/** Delegated children carry only the delegation channel; roots never do. */
function hasCoherentSource(next: GovernanceActivationRevision): boolean {
  return (next.parentDispatch !== null) === (next.decisionSource === 'delegation');
}

/** One decision keeps one channel and one actor across its revisions. */
function sameDecision(
  previous: GovernanceActivationRevision,
  next: GovernanceActivationRevision,
): boolean {
  return (
    next.decisionSource === previous.decisionSource &&
    next.decisionActor.actorId === previous.decisionActor.actorId &&
    next.decisionActor.actorEmail === previous.decisionActor.actorEmail &&
    next.decisionActor.actorDisplayName === previous.decisionActor.actorDisplayName &&
    next.decisionActor.actorSource === previous.decisionActor.actorSource &&
    next.decisionActor.actorAssurance === previous.decisionActor.actorAssurance
  );
}

function isDelegationContinuation(
  previous: GovernanceActivationRevision,
  next: GovernanceActivationRevision,
): boolean {
  if (
    !sameActivation(previous, next) ||
    next.parentDispatch === null ||
    previous.parentDispatch === null
  )
    return false;
  return (
    previous.status === 'active' &&
    next.status === 'active' &&
    previous.sessionId === next.sessionId &&
    next.revision === previous.revision + 1 &&
    previous.parentDispatch.sessionId === next.parentDispatch.sessionId &&
    // Native call IDs are provider-supplied and unique only within one
    // host-generated assistant message.
    (previous.parentDispatch.messageId !== next.parentDispatch.messageId ||
      previous.parentDispatch.callId !== next.parentDispatch.callId) &&
    previous.decisionId === next.decisionId
  );
}

function isNextRootRevision(
  previous: GovernanceActivationRevision,
  next: GovernanceActivationRevision,
): boolean {
  return (
    previous.sessionId === next.sessionId &&
    next.revision === previous.revision + 1 &&
    previous.parentDispatch === null &&
    next.parentDispatch === null
  );
}

function isInitialEnrollment(next: GovernanceActivationRevision): boolean {
  if (next.revision !== 1 || next.previousDigest !== null) return false;
  if (next.parentDispatch !== null) {
    return (
      next.status === 'active' &&
      next.sessionId !== next.rootSessionId &&
      next.parentDispatch.sessionId !== next.sessionId
    );
  }
  return (
    next.sessionId === next.rootSessionId && next.status === 'activating' && next.generation === 1
  );
}

function isReactivation(
  previous: GovernanceActivationRevision,
  next: GovernanceActivationRevision,
): boolean {
  return (
    next.status === 'activating' &&
    next.generation === previous.generation + 1 &&
    next.activationId !== previous.activationId &&
    next.rootSessionId === next.sessionId
  );
}

function sameActivation(
  previous: GovernanceActivationRevision,
  next: GovernanceActivationRevision,
): boolean {
  return (
    next.generation === previous.generation &&
    next.activationId === previous.activationId &&
    next.rootSessionId === previous.rootSessionId &&
    next.directory === previous.directory &&
    next.worktreeRoot === previous.worktreeRoot &&
    next.policyDigest === previous.policyDigest
  );
}

export function governanceActivationTarget(
  action: GovernanceActivationAction,
): GovernanceActivationRevision['status'] {
  switch (action) {
    case 'start':
      return 'activating';
    case 'activate':
      return 'active';
    case 'begin_end':
      return 'ending';
    case 'end':
      return 'inactive';
    case 'enroll':
      return 'active';
  }
}
