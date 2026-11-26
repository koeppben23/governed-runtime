/** Read-only validation reporting: machine outcomes never masquerade as command executions. */
import type { AuditEvent } from '../state/evidence.js';
import { Event, Phase, type SessionState } from '../state/schema.js';
import { resolveTransition } from '../machine/topology.js';
import { evaluateValidationEvidence } from '../machine/validation-evidence.js';

function validationPhase(value: unknown): value is 'VALIDATION' | 'IMPL_VALIDATION' {
  return value === 'VALIDATION' || value === 'IMPL_VALIDATION';
}

function validTransition(event: AuditEvent): boolean {
  const from = Phase.safeParse(event.detail.from);
  const action = Event.safeParse(event.detail.event);
  return (
    from.success &&
    action.success &&
    event.event === `transition:${action.data}` &&
    resolveTransition(from.data, action.data) === event.detail.to &&
    event.phase === event.detail.to
  );
}

function boundAttempt(attempt: SessionState['validationAttempts'][number], state: SessionState) {
  return attempt.scope === 'baseline'
    ? attempt.planDigest === state.plan?.current.digest
    : attempt.implementationDigest === state.implementation?.digest &&
        attempt.implementationId === state.implementation?.implementationId;
}

function noCommandPolicyAllows(state: SessionState | null): boolean {
  return (
    state !== null && state.activeChecks.length === 0 && !evaluateValidationEvidence(state).blocked
  );
}

function missingEvidenceDetail(missing: readonly string[], noCommandPolicy: boolean): string {
  if (missing.length === 0) return '';
  return noCommandPolicy
    ? `; no execution evidence for ${missing.join(', ')}; canonical no-command policy permits progression (not execution proof)`
    : `; execution evidence NOT_VERIFIED for ${missing.join(', ')}`;
}

/** A successful host call and a durable attempt are separate observations, not two executions. */
export function validationExecutionCheck(
  events: readonly AuditEvent[],
  state: SessionState | null,
): { readonly name: string; readonly passed: boolean; readonly detail: string } {
  const reached = new Set(events.flatMap((e) => [e.phase, e.detail.from].filter(validationPhase)));
  const transitions = events.filter(
    (e) =>
      e.event.startsWith('transition:') &&
      (validationPhase(e.detail.from) || validationPhase(e.detail.to) || validationPhase(e.phase)),
  );
  if (transitions.some((e) => !validTransition(e))) {
    return {
      name: 'validation_executed',
      passed: false,
      detail: 'Invalid validation transition; execution evidence NOT_VERIFIED',
    };
  }
  if (
    state !== null &&
    events.some(
      (e) =>
        e.flowguardSessionId !== state.id ||
        (e.hostSessionId !== undefined && e.hostSessionId !== state.binding.hostSessionId),
    )
  ) {
    return {
      name: 'validation_executed',
      passed: false,
      detail: 'Session state does not bind the audited session',
    };
  }
  if (reached.size === 0) {
    return {
      name: 'validation_executed',
      passed: true,
      detail: 'No validation phase reached (not applicable)',
    };
  }
  const outcomes = transitions.filter(
    (e) =>
      validationPhase(e.detail.from) && e.detail.event !== 'ABORT' && e.detail.event !== 'ERROR',
  ).length;
  const attempts = state?.validationAttempts.filter((a) => boundAttempt(a, state)) ?? [];
  const commands = attempts.filter((a) => a.result.outcome !== 'blocked');
  const observed = new Set<string>();
  for (const attempt of commands)
    observed.add(attempt.scope === 'baseline' ? 'VALIDATION' : 'IMPL_VALIDATION');
  const hostCalls = events.filter(
    (e) =>
      e.event === 'tool_call:flowguard_run_check' &&
      e.detail.tool === e.event.slice('tool_call:'.length) &&
      e.detail.success === true &&
      validationPhase(e.phase),
  );
  // Without state, report only successful explicit calls. A transition alone cannot
  // distinguish a real command from an allowed zero-check evaluation.
  if (state === null) for (const call of hostCalls) observed.add(call.phase);
  const noCommandPolicy = noCommandPolicyAllows(state);
  const missing = [...reached].filter((phase) => !observed.has(phase));
  return {
    name: 'validation_executed',
    passed: missing.length === 0 || noCommandPolicy,
    detail:
      `${attempts.length} bound validation attempt(s), ${commands.length} command result(s), ` +
      `${hostCalls.length} successful explicit call(s), ${outcomes} machine outcome(s)` +
      missingEvidenceDetail(missing, noCommandPolicy),
  };
}
