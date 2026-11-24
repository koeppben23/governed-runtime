/** The demo projects the installed product's decision receipt; it creates no authority. */
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import {
  assertCompleteAuditWindow,
  assertHumanDecisionRefusalUnchanged,
} from '../lib/recovery-state.mjs';
import { DemoNotVerifiedError } from '../lib/results.mjs';

const nonempty = (value) => typeof value === 'string' && value.length > 0;
const digest = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const stillPending = (state) =>
  state.pendingAuditOperations?.some((item) => item.status !== 'reconciled');

export function assertNativeDecisionWitness({
  before,
  after,
  auditBefore,
  events,
  sessionId,
  startedAt,
  completedAt,
  verdict,
  rationale,
  expectedDenial,
  expectedDenialTool,
  expectedTargetPhase,
}) {
  const floor = auditBefore.length;
  const window = assertCompleteAuditWindow(after, floor, events);
  const inDispatch = (event) => {
    const time = Date.parse(event.occurredAt);
    return time >= startedAt && time <= completedAt;
  };
  if (
    after.flowguardSessionId !== before.flowguardSessionId ||
    before.binding?.hostSessionId !== sessionId ||
    after.binding?.hostSessionId !== sessionId ||
    !isDeepStrictEqual(auditBefore, events.slice(0, floor)) ||
    stillPending(before) ||
    stillPending(after)
  ) {
    throw new DemoNotVerifiedError('native decision lost its pre-dispatch state or audit anchor');
  }
  const checkpoint = after.auditOutboxCheckpoint;
  if (checkpoint && events[checkpoint.auditSequence - 1]?.chainHash !== checkpoint.chainHash) {
    throw new DemoNotVerifiedError('native decision audit does not cover the state checkpoint');
  }
  const calls = window.filter((event) => event.event === 'tool_call:flowguard_decision');
  const call = calls[0];
  const callId = call?.detail.argsSummary?.callID;
  if (
    calls.length !== 1 ||
    !inDispatch(call) ||
    call.hostSessionId !== sessionId ||
    call.detail.tool !== 'flowguard_decision' ||
    call.detail.argsSummary?.sessionID !== sessionId ||
    !nonempty(callId) ||
    events.some((event) => event !== call && event.detail.argsSummary?.callID === callId)
  ) {
    throw new DemoNotVerifiedError('native decision has no unique new dispatch-bound tool call');
  }
  if (!expectedDenial) {
    assertApproval(
      window,
      auditBefore,
      call,
      sessionId,
      before,
      after,
      verdict,
      rationale,
      expectedTargetPhase,
      inDispatch,
    );
    return window;
  }
  // The host does not return the generated call ID. Bind it by the isolated
  // serial dispatch interval, unchanged prefix, exact tool/session and unique
  // matching audit error that follows it, not by HTTP status or response text.
  assertHumanDecisionRefusalUnchanged(
    after,
    { tool: expectedDenialTool ?? 'flowguard_decision', callId, startedAt, at: completedAt },
    floor,
    events,
    expectedDenial,
    true,
  );
  const errors = window.filter((event) => event.event.startsWith('error:'));
  if (
    window.some((event) => event !== call && event.event.startsWith('tool_call:')) ||
    errors.length !== 1 ||
    window.at(-1) !== errors[0] ||
    errors[0].event !== `error:${expectedDenial}` ||
    errors[0].detail.code !== expectedDenial ||
    errors[0].hostSessionId !== sessionId ||
    errors[0].auditSequence <= call.auditSequence ||
    !inDispatch(errors[0])
  ) {
    throw new DemoNotVerifiedError(
      'native refusal audit is ambiguous or lacks its closing error witness',
    );
  }
  if (!isDeepStrictEqual(before, after)) {
    throw new DemoNotVerifiedError('native refusal changed persisted session state');
  }
  return window;
}

function assertApproval(
  window,
  auditBefore,
  call,
  sessionId,
  before,
  after,
  verdict,
  rationale,
  target,
  inDispatch,
) {
  const receipts = window.filter((event) => event.event.startsWith('decision:DEC-'));
  const receipt = receipts[0];
  const detail = receipt?.detail;
  const operation = detail?.operation;
  if (
    call.detail.success !== true ||
    call.detail.errorCode !== undefined ||
    receipts.length !== 1 ||
    !inDispatch(receipt) ||
    receipt.hostSessionId !== sessionId ||
    operation?.source !== 'host_command' ||
    operation.sessionId !== sessionId ||
    operation.rootSessionId !== sessionId ||
    !nonempty(operation.operationId) ||
    auditBefore.some((event) => event.detail.operation?.operationId === operation.operationId) ||
    !digest(operation.stateDigest) ||
    operation.stateDigest !== detail.preStateDigest ||
    !digest(detail.postStateDigest) ||
    detail.preStateDigest === detail.postStateDigest ||
    detail.stateChanged !== true ||
    operation.verdict !== verdict ||
    detail.verdict !== verdict ||
    detail.rationale !== rationale ||
    operation.rationaleDigest !== createHash('sha256').update(rationale).digest('hex') ||
    detail.fromPhase !== before.phase ||
    !target ||
    after.phase !== target
  ) {
    throw new DemoNotVerifiedError(
      'native approval has no matching operation-bound persisted receipt',
    );
  }
  const transitions = window.filter((event) => event.event.startsWith('transition:'));
  const first = transitions[0];
  if (
    !first ||
    first.detail.from !== detail.fromPhase ||
    first.detail.to !== detail.toPhase ||
    first.event !== `transition:${detail.transitionEvent}` ||
    first.occurredAt !== detail.transitionAt ||
    first.detail.preStateDigest !== detail.preStateDigest ||
    first.detail.postStateDigest !== detail.postStateDigest ||
    transitions.some(
      (event, index) =>
        event.hostSessionId !== sessionId ||
        !inDispatch(event) ||
        (index > 0 && event.detail.from !== transitions[index - 1].detail.to),
    ) ||
    transitions.at(-1).detail.to !== target ||
    transitions.filter((event) => event.detail.to === target).length !== 1
  ) {
    throw new DemoNotVerifiedError(
      'native approval has no complete transition witness to its target',
    );
  }
}
