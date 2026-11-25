/** External witnesses for the Java harness's native /start and /check turns. */
import { isDeepStrictEqual } from 'node:util';
import { assertCompleteAuditWindow } from '../lib/recovery-state.mjs';
import { DemoNotVerifiedError } from '../lib/results.mjs';

const nonempty = (value) => typeof value === 'string' && value.length > 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

function activationProven(window, after, sessionId) {
  const activations = window.filter((event) => event.event === 'governance:activated');
  if (activations.length !== 1) return false;
  const [{ id, phase, detail }] = activations;
  return (
    nonempty(id) &&
    detail.activationId === id &&
    nonempty(detail.decisionId) &&
    detail.channel === 'host_command' &&
    detail.rootSessionId === sessionId &&
    detail.worktreeRoot === after.binding.worktree &&
    digest(detail.policyDigest) &&
    detail.policyDigest === after.policySnapshot?.hash &&
    phase === after.phase &&
    !window.some((event) => event.event === 'governance:ended')
  );
}

function checksProven(before, after, auditBefore, window, inDispatch, sessionId) {
  const tool = 'flowguard_run_check';
  const calls = window.filter(
    (event) => event.event === `tool_call:${tool}` || event.detail.tool === tool,
  );
  const ledgerBefore = before.validationAttempts;
  const ledgerAfter = after.validationAttempts;
  if (
    calls.length === 0 ||
    window.some((event) => event.event.startsWith('governance:')) ||
    !Array.isArray(ledgerBefore) ||
    !Array.isArray(ledgerAfter) ||
    !isDeepStrictEqual(ledgerBefore, ledgerAfter.slice(0, ledgerBefore.length))
  )
    return false;
  const attempts = ledgerAfter.slice(ledgerBefore.length);
  const callIds = new Set(auditBefore.map((event) => event.detail.argsSummary?.callID));
  const attemptIds = new Set(ledgerBefore.map((attempt) => attempt?.attemptId));
  const first = attempts[0];
  const correctSubject =
    (before.phase === 'VALIDATION' &&
      first?.scope === 'baseline' &&
      digest(first.planDigest) &&
      first.planDigest === before.plan?.current?.digest) ||
    (before.phase === 'IMPL_VALIDATION' &&
      first?.scope === 'implementation' &&
      nonempty(first.implementationId) &&
      first.implementationId === before.implementation?.implementationId &&
      digest(first.implementationDigest) &&
      first.implementationDigest === before.implementation?.digest);
  if (!correctSubject || attempts.length !== calls.length) return false;
  return calls.every((call, index) => {
    const { detail } = call;
    const callId = detail.argsSummary?.callID;
    const { attemptId, result } = attempts[index] ?? {};
    if (
      call.event !== `tool_call:${tool}` ||
      detail.tool !== tool ||
      detail.success !== true ||
      detail.errorCode !== undefined ||
      !Number.isInteger(detail.transitionCount) ||
      detail.transitionCount < 0 ||
      detail.argsSummary?.sessionID !== sessionId ||
      !nonempty(callId) ||
      callIds.has(callId) ||
      window.some((event) => event !== call && event.detail.argsSummary?.callID === callId) ||
      !nonempty(attemptId) ||
      attemptIds.has(attemptId) ||
      !nonempty(result?.checkId) ||
      !digest(result?.outputDigest) ||
      !inDispatch(result?.executedAt) ||
      Date.parse(result.executedAt) > Date.parse(call.occurredAt) ||
      (index > 0 && Date.parse(result.executedAt) < Date.parse(calls[index - 1].occurredAt))
    )
      return false;
    callIds.add(callId);
    attemptIds.add(attemptId);
    return true;
  });
}

/**
 * /start writes an explicit activation record. /check instead runs a scoped
 * prompt: the fresh run-check calls and execution ledger witness execution
 * during this serial dispatch, not successful checks or review completion.
 */
export function assertNativeCommandWitness({
  command,
  before,
  after,
  auditBefore,
  events,
  sessionId,
  startedAt,
  completedAt,
}) {
  const window = assertCompleteAuditWindow(after, auditBefore.length, events);
  const checkpoint = after.auditOutboxCheckpoint;
  const inDispatch = (at) => {
    const time = Date.parse(at);
    return time >= startedAt && time <= completedAt;
  };
  if (
    after.binding?.hostSessionId !== sessionId ||
    !isDeepStrictEqual(auditBefore, events.slice(0, auditBefore.length)) ||
    (checkpoint && events[checkpoint.auditSequence - 1]?.chainHash !== checkpoint.chainHash) ||
    window.some(
      (event) =>
        event.hostSessionId !== sessionId ||
        !inDispatch(event.occurredAt) ||
        event.event.startsWith('error:'),
    )
  ) {
    throw new DemoNotVerifiedError(
      `native /${command} has no continuous dispatch-bound audit window`,
    );
  }
  const proven =
    command === 'start'
      ? before === null && auditBefore.length === 0 && activationProven(window, after, sessionId)
      : command === 'check' &&
        before?.flowguardSessionId === after.flowguardSessionId &&
        before.binding?.hostSessionId === sessionId &&
        checksProven(before, after, auditBefore, window, inDispatch, sessionId);
  if (!proven) {
    throw new DemoNotVerifiedError(`native /${command} has no unique current command witness`);
  }
  return window;
}
