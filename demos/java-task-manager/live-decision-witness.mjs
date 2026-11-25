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
const isToolCall = (event) => event.event.startsWith('tool_call:');
const isError = (event) => event.event.startsWith('error:');
const isStateEvent = (event) =>
  digest(event.detail?.preStateDigest) && digest(event.detail?.postStateDigest);

/**
 * Reject tool or error evidence that cannot be interpreted as a clean decision
 * outcome. Legitimate automatic follow-up calls are allowed only as successful,
 * fully typed tool calls inside the settled dispatch interval.
 */
function assertToolEvidence(
  window,
  { expectedDenial, expectedDenialTool, call, sessionId, inDispatch },
) {
  for (const event of window) {
    if (!isToolCall(event) && !isError(event)) continue;
    if (event.hostSessionId !== sessionId || !inDispatch(event)) {
      throw new DemoNotVerifiedError(
        'native decision window contains foreign or late tool evidence',
      );
    }
    if (isError(event)) {
      if (!expectedDenial) {
        throw new DemoNotVerifiedError(
          'native approval window contains a contradictory error event',
        );
      }
      continue;
    }
    const detail = event.detail;
    if (
      !nonempty(detail?.tool) ||
      event.event !== `tool_call:${detail.tool}` ||
      typeof detail.success !== 'boolean' ||
      !Number.isInteger(detail.transitionCount) ||
      detail.transitionCount < 0
    ) {
      throw new DemoNotVerifiedError('native decision window contains ambiguous tool evidence');
    }
    if (detail.success) {
      if (detail.errorCode !== undefined) {
        throw new DemoNotVerifiedError('native decision window mixes success with an error code');
      }
      continue;
    }
    if (
      !nonempty(detail.errorCode) ||
      !expectedDenial ||
      event !== call ||
      detail.tool !== (expectedDenialTool ?? 'flowguard_decision') ||
      detail.errorCode !== expectedDenial
    ) {
      throw new DemoNotVerifiedError('native decision window contains an unexplained tool failure');
    }
  }
}

/**
 * Bind the receipt to the observed state snapshots through the installed
 * product's canonical state-authority digest. The audit chain may contain
 * automatic follow-up transitions; every pre/post pair must link from the
 * pre-dispatch state to the settled state. Duplicate pairs from the same state
 * write (transition + semantic receipt) are allowed once.
 */
function assertStateDigestChain({
  window,
  beforeDigest,
  afterDigest,
  receipt,
  detail,
  sessionId,
  inDispatch,
}) {
  if (
    !digest(beforeDigest) ||
    !digest(afterDigest) ||
    detail.preStateDigest !== beforeDigest ||
    detail.postStateDigest === beforeDigest
  ) {
    throw new DemoNotVerifiedError('native approval receipt is not bound to the observed state');
  }
  const stateEvents = window.filter(
    (event) => event.event.startsWith('transition:') || isStateEvent(event),
  );
  if (!stateEvents.includes(receipt)) {
    throw new DemoNotVerifiedError('native approval receipt is absent from the state-digest chain');
  }
  let current = beforeDigest;
  let previous = null;
  for (const event of stateEvents) {
    if (!isStateEvent(event)) {
      throw new DemoNotVerifiedError('native transition has missing or malformed state digests');
    }
    if (event.hostSessionId !== sessionId || !inDispatch(event)) {
      throw new DemoNotVerifiedError('native state chain contains foreign or late evidence');
    }
    const pre = event.detail.preStateDigest;
    const post = event.detail.postStateDigest;
    if (pre === current) {
      current = post;
      previous = { pre, post };
    } else if (previous && pre === previous.pre && post === previous.post) {
      continue;
    } else {
      throw new DemoNotVerifiedError('native approval state-digest chain is discontinuous');
    }
  }
  if (current !== afterDigest) {
    throw new DemoNotVerifiedError(
      'native approval state-digest chain does not reach the settled state',
    );
  }
  const anchor = stateEvents.filter(
    (event) =>
      event.detail.preStateDigest === beforeDigest &&
      event.detail.postStateDigest === detail.postStateDigest,
  );
  if (!anchor.includes(receipt) || !anchor.some((event) => event.event.startsWith('transition:'))) {
    throw new DemoNotVerifiedError(
      'native approval has no transition bound to its receipt state chain',
    );
  }
}

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
  stateDigest,
}) {
  if (typeof stateDigest !== 'function') {
    throw new DemoNotVerifiedError('native decision has no canonical state-digest authority');
  }
  const beforeDigest = stateDigest(before);
  const afterDigest = stateDigest(after);
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
  assertToolEvidence(window, {
    expectedDenial,
    expectedDenialTool,
    call,
    sessionId,
    inDispatch,
  });
  if (!expectedDenial) {
    assertApproval({
      window,
      auditBefore,
      call,
      sessionId,
      before,
      after,
      verdict,
      rationale,
      target: expectedTargetPhase,
      inDispatch,
      beforeDigest,
      afterDigest,
    });
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
  const errors = window.filter(isError);
  if (
    window.some((event) => event !== call && isToolCall(event)) ||
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

function assertApproval({
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
  beforeDigest,
  afterDigest,
}) {
  const receipts = window.filter((event) => event.event.startsWith('decision:DEC-'));
  const receipt = receipts[0];
  const detail = receipt?.detail;
  const operation = detail?.operation;
  const mismatches = [];
  if (call.detail.success !== true) mismatches.push('call-not-successful');
  if (call.detail.errorCode !== undefined) mismatches.push('call-has-error');
  if (receipts.length !== 1) mismatches.push('receipt-count');
  if (!receipt || !inDispatch(receipt)) mismatches.push('receipt-dispatch');
  if (receipt?.hostSessionId !== sessionId) mismatches.push('receipt-host-session');
  if (operation?.source !== 'host_command') mismatches.push('operation-source');
  if (operation?.sessionId !== sessionId) mismatches.push('operation-session');
  if (operation?.rootSessionId !== sessionId) mismatches.push('operation-root');
  if (!nonempty(operation?.operationId)) mismatches.push('operation-id');
  if (
    operation?.operationId &&
    auditBefore.some((event) => event.detail.operation?.operationId === operation.operationId)
  )
    mismatches.push('operation-reused');
  if (!digest(operation?.stateDigest)) mismatches.push('operation-state-digest-format');
  if (operation?.stateDigest !== beforeDigest) mismatches.push('operation-state-digest');
  if (operation?.stateDigest !== detail?.preStateDigest) mismatches.push('operation-pre-digest');
  if (!digest(detail?.postStateDigest)) mismatches.push('receipt-post-digest-format');
  if (detail?.preStateDigest === detail?.postStateDigest)
    mismatches.push('receipt-no-state-change');
  if (detail?.stateChanged !== true) mismatches.push('receipt-state-changed');
  if (operation?.verdict !== verdict) mismatches.push('operation-verdict');
  if (detail?.verdict !== verdict) mismatches.push('receipt-verdict');
  if (detail?.rationale !== rationale) mismatches.push('receipt-rationale');
  if (operation?.rationaleDigest !== createHash('sha256').update(rationale).digest('hex'))
    mismatches.push('receipt-rationale-digest');
  if (detail?.fromPhase !== before.phase) mismatches.push('receipt-from-phase');
  if (!target) mismatches.push('target-missing');
  if (after.phase !== target) mismatches.push('after-phase');
  if (mismatches.length > 0) {
    throw new DemoNotVerifiedError(
      `native approval has no matching operation-bound persisted receipt [${mismatches.join(', ')}]`,
    );
  }
  const transitions = window.filter((event) => event.event.startsWith('transition:'));
  const first = transitions[0];
  const transitionMismatches = [];
  if (!first) transitionMismatches.push('transition-missing');
  if (first?.detail.from !== detail.fromPhase) transitionMismatches.push('transition-from');
  if (first?.detail.to !== detail.toPhase) transitionMismatches.push('transition-to');
  if (first?.event !== `transition:${detail.transitionEvent}`)
    transitionMismatches.push('transition-event');
  if (first?.occurredAt !== detail.transitionAt) transitionMismatches.push('transition-time');
  if (first?.detail.preStateDigest !== detail.preStateDigest)
    transitionMismatches.push('transition-pre-digest');
  if (first?.detail.postStateDigest !== detail.postStateDigest)
    transitionMismatches.push('transition-post-digest');
  if (
    transitions.some(
      (event, index) =>
        event.hostSessionId !== sessionId ||
        !inDispatch(event) ||
        (index > 0 && event.detail.from !== transitions[index - 1].detail.to),
    )
  )
    transitionMismatches.push('transition-chain');
  if (transitions.at(-1)?.detail.to !== target) transitionMismatches.push('transition-target');
  if (transitions.filter((event) => event.detail.to === target).length !== 1)
    transitionMismatches.push('transition-target-count');
  if (transitionMismatches.length > 0) {
    throw new DemoNotVerifiedError(
      `native approval has no complete transition witness to its target [${transitionMismatches.join(', ')}]`,
    );
  }
  assertStateDigestChain({
    window,
    beforeDigest,
    afterDigest,
    receipt,
    detail,
    sessionId,
    inDispatch,
  });
}
