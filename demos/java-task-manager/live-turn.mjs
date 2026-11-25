/** Dispatch one turn and validate its audit or CLI transcript evidence. */
import { HostTransportError } from '../lib/host-http.mjs';
import { DemoNotVerifiedError } from '../lib/results.mjs';
import {
  assertExpectedDenial,
  authorizedRetryEvents,
  captureRetryHints,
  sameTurnRecoveryProofs,
  structuredRearmSupersedesTerminal,
  toolDenialCodes,
  toolDenialEvents,
  toolUseEvents,
  transcriptTrust,
} from '../lib/transcript.mjs';
import {
  assertHumanDecisionRefusalUnchanged,
  expectRecovery,
  readAuditEvents,
  recoveryPersisted,
  TICKET_SOURCE_CONFLICT_CODES,
  WAIT_STATE_RECOVERY_CODES,
} from '../lib/recovery-state.mjs';
import {
  assertHostCallOk,
  assertTypedAuditConsistency,
  HOST_NATIVE_COMMANDS,
  HOST_TRANSPORT_COMMANDS,
} from './live-host-transport.mjs';
import { pendingPlanPreflight, PLAN_PREFLIGHT_RECOVERY_CODES } from './live-plan-preflight.mjs';
import { lastAuditSequence } from './live-session-evidence.mjs';
import {
  classifyRearmEvent,
  classifyUnexpectedBlock,
  isRecoverableFamily,
  NEXT_STEP_RECOVERY_CODES,
  persistedReviewExhausted,
  PLAN_REVIEW_CORRECTION_CODE,
  planReviewSameTurnCorrection,
  unexpectedDenialCodes,
} from './live-turn-recovery.mjs';
export async function turn(runner, session, label, prompt, options = {}) {
  const slash = /^\/([a-z-]+)(?:\s|$)/.exec(prompt ?? '')?.[1];
  if (
    runner.host &&
    HOST_TRANSPORT_COMMANDS.has(slash) &&
    !HOST_TRANSPORT_COMMANDS.has(options.command)
  ) {
    throw new HostTransportError(
      'HOST_COMMAND_INVALID',
      'native command must use the explicit command boundary',
    );
  }
  if (options.command && !HOST_TRANSPORT_COMMANDS.has(options.command)) {
    prompt = `/${options.command}${prompt ? ` ${prompt}` : ''}`;
    options = { ...options, command: undefined };
  }
  const phaseBefore = runner.currentPhase(session);
  const digestBefore = runner.currentStateDigest(session);
  const reviewProgressBefore = session.sessionId ? runner.reviewProgress(session) : null;
  // Recovery witnesses must be bound to events appended by THIS turn; a
  // historical sequence may never confirm a later operation.
  const auditFloorBefore =
    session.sessionId && !options.command
      ? lastAuditSequence(runner.configDir, session.sessionId)
      : 0;
  let result;
  if (options.command && HOST_NATIVE_COMMANDS.has(options.command)) {
    result = await runner.hostNativeCommandTransport(session, label, options.command);
  } else if (options.command) {
    result = await runner.hostCommandTransport(session, label, options.command, options);
  } else {
    const model = runner.options.variant
      ? `${runner.options.model}#${runner.options.variant}`
      : runner.options.model;
    const args = ['run', '-m', model, '--format', 'json'];
    if (session.sessionId) args.push('--session', session.sessionId);
    if (prompt) args.push(prompt);
    result = await runner.hostStep(label, session.workspace, args);
  }
  assertHostCallOk(result, label);
  const observed = result.sessionIds.at(-1);
  if (session.sessionId && observed && observed !== session.sessionId) {
    throw new Error(`${label}: session continuity changed (${observed})`);
  }
  session.sessionId = session.sessionId ?? observed;
  if (!session.sessionId) throw new Error(`${label}: no host session id observed`);
  const digestAfter = runner.currentStateDigest(session);
  const stateObserved = digestBefore !== null && digestAfter !== null;
  session.lastTurn = {
    label,
    toolCalls: result.auditEvidence
      ? result.auditEvidence.length
      : toolUseEvents(result.stdout).length,
    stateObserved,
    // An unreadable state digest is NOT an observed unchanged state.
    stateChanged: stateObserved ? digestAfter !== digestBefore : null,
    phaseAfter: runner.currentPhase(session),
  };
  if (result.auditEvidence) {
    const command = options.command ?? /^\/([a-z-]+)/.exec(prompt ?? '')?.[1];
    assertTypedAuditConsistency(result.auditEvidence, label);
    await runner.settleAwaitingRecovery(session, label, command);
    if (!options.expectedDenial) {
      const denials = result.auditEvidence.filter(
        (event) => event.success === false && event.errorCode,
      );
      if (denials.length > 0) {
        throw new DemoNotVerifiedError(
          `${label}: unhandled typed denial(s) [${[
            ...new Set(denials.map((event) => event.errorCode)),
          ].join(', ')}]; the proof is NOT_VERIFIED`,
        );
      }
    }
    if (
      options.expectedTargetPhase !== undefined &&
      runner.currentPhase(session) !== options.expectedTargetPhase
    ) {
      throw new Error(
        `${label}: expected target phase ${options.expectedTargetPhase}, observed ${String(
          runner.currentPhase(session),
        )}`,
      );
    }
    return result;
  }
  if (options.expectedDenial) {
    assertExpectedDenial(result.stdout, options.expectedDenial, options.expectedDenialTool);
    await runner.settleAwaitingRecovery(
      session,
      label,
      options.command ?? /^\/([a-z-]+)/.exec(prompt ?? '')?.[1],
    );
    return result;
  }

  const trust = transcriptTrust(result.stdout);
  if (!trust.readable) {
    session.transcriptWarnings = session.transcriptWarnings ?? [];
    session.transcriptWarnings.push({ step: label, ...trust });
    runner.log(
      `${label}: untrustworthy transcript (${trust.framingLosses.length} framing loss(es), ` +
        `${trust.unreadable.length} unreadable governed tool output(s)); no proof can be credited`,
    );
    throw new DemoNotVerifiedError(
      `${label}: transcript is not trustworthy (${trust.framingLosses.length} framing loss(es), ` +
        `${trust.unreadable.length} unreadable governed tool output(s)); the proof is NOT_VERIFIED`,
    );
  }
  await runner.settleAwaitingRecovery(
    session,
    label,
    options.command ?? /^\/([a-z-]+)/.exec(prompt ?? '')?.[1],
  );
  const recoverable = [...new Set(toolDenialCodes(result.stdout).filter(isRecoverableFamily))];
  session.recoveryObservations = session.recoveryObservations ?? [];
  session.recoveryObservations.push(
    ...toolDenialEvents(result.stdout).map((event) => ({
      step: label,
      status: 'observed',
      code: event.code,
      denialIndex: event.index,
    })),
  );
  const proofs = sameTurnRecoveryProofs(result.stdout);
  const recoverableProofs = proofs.recovered.filter(
    (proof) => isRecoverableFamily(proof.code) && !PLAN_PREFLIGHT_RECOVERY_CODES.has(proof.code),
  );
  const operationRecovered = [
    ...new Set(
      recoverableProofs.filter((proof) => proof.binding === 'operation').map((proof) => proof.code),
    ),
  ];
  const laterSuccessOnly = [
    ...new Set(
      recoverableProofs.filter((proof) => proof.binding === 'tool').map((proof) => proof.code),
    ),
  ];
  // Only an OPERATION-bound correction resolves the denial in-turn. A later
  // success without an operation binding is an observation; resolving it
  // requires an independent persisted proof from the next required step.
  const sameTurnRecovered = operationRecovered;
  const unprovenOccurrences = [...new Set(proofs.unproven.map((proof) => proof.code))];
  // The retry envelope itself only exists for retryable capture failures.
  const allRetryEvents = authorizedRetryEvents(result.stdout);
  let rearmState = null;
  try {
    rearmState = runner.requireBoundState(session).state;
  } catch {
    rearmState = null;
  }
  session.rearmAttemptsSeen = session.rearmAttemptsSeen ?? new Set();
  const authorizedRearms = [];
  const staleRearms = [];
  for (const event of allRetryEvents) {
    const classified = classifyRearmEvent(event, rearmState, session.rearmAttemptsSeen);
    if (classified.kind === 'authorized')
      authorizedRearms.push({ event, attempt: classified.attempt });
    else staleRearms.push(event);
  }
  const retryRecovered = [...new Set(authorizedRearms.map(({ event }) => event.code))];
  const retryHints = captureRetryHints(result.stdout);
  if (staleRearms.length > 0) {
    session.retryHints = [
      ...(session.retryHints ?? []),
      { step: label, events: staleRearms, reason: 'stale_rearm_attempt' },
    ];
    runner.log(
      `${label}: structured re-arm referenced a spent or unknown attempt ` +
        `[${[...new Set(staleRearms.map((event) => event.code))].join(', ')}]; no recovery proof credited`,
    );
  }
  if (retryHints.length > 0) {
    session.retryHints = [...(session.retryHints ?? []), { step: label, events: retryHints }];
    runner.log(
      `${label}: retryable host hint observed without complete review identities; no re-arm proof credited`,
    );
  }
  session.recoveredDenials = session.recoveredDenials ?? [];
  // A wait-state guard is corrected only by the SAME operation making actual
  // progress: a later same-tool success AND an advanced persisted review
  // projection in this turn. A bare later success stays an observation.
  const waitStateProgress = new Set();
  if (laterSuccessOnly.length > 0 && reviewProgressBefore !== null) {
    const progressAfter = runner.reviewProgress(session);
    for (const code of laterSuccessOnly) {
      if (!WAIT_STATE_RECOVERY_CODES.has(code) || progressAfter === null) continue;
      const advanced =
        code === 'ADR_REVIEW_IN_PROGRESS'
          ? progressAfter.archIterations > reviewProgressBefore.archIterations ||
            progressAfter.archFindings > reviewProgressBefore.archFindings
          : progressAfter.planIteration > reviewProgressBefore.planIteration;
      if (advanced) waitStateProgress.add(code);
    }
  }
  if (waitStateProgress.size > 0) {
    session.recoveredDenials.push({
      status: 'proven',
      step: label,
      codes: [...waitStateProgress],
      evidence: 'same_turn_wait_state_progress',
    });
    runner.log(
      `${label}: recovered via same-turn wait-state progress [${[...waitStateProgress].join(', ')}]`,
    );
  }
  const resolvedLaterSuccess = laterSuccessOnly.filter((code) => !waitStateProgress.has(code));
  const preflight = pendingPlanPreflight(
    result.stdout,
    label,
    rearmState,
    session.sessionId,
    phaseBefore,
    recoverable.some((code) => PLAN_PREFLIGHT_RECOVERY_CODES.has(code))
      ? await runner.reviewInvocationAuthority(session.workspace)
      : undefined,
  );
  if (preflight) {
    session.recoveryObservations.push(preflight);
    runner.log(
      `${label}: plan preflight denial(s) [${preflight.codes.join(', ')}] pending verification at the bound plan gate`,
    );
  }
  if (operationRecovered.length > 0) {
    session.recoveredDenials.push({
      status: 'proven',
      step: label,
      codes: operationRecovered,
      evidence: 'same_turn_operation_recovery',
    });
    runner.log(
      `${label}: recovered via same-turn operation recovery [${operationRecovered.join(', ')}]`,
    );
  }
  if (resolvedLaterSuccess.length > 0) {
    session.recoveryObservations.push({
      status: 'pending_verification',
      step: label,
      codes: resolvedLaterSuccess,
      evidence: 'later_tool_success',
    });
    runner.log(
      `${label}: later success of the same tool recorded without an operation binding ` +
        `[${resolvedLaterSuccess.join(', ')}]; the next required step must prove a persisted transition`,
    );
  }
  for (const { event, attempt } of authorizedRearms) {
    const bound = attempt.status === 'bound';
    session.recoveryObservations.push({
      status: bound ? 'proven' : 'pending_verification',
      lifecycle: bound ? 'rearm_proven' : 'rearm_authorized',
      step: label,
      codes: [event.code],
      evidence: 'structured_rearm',
      obligationId: event.obligationId,
      attemptId: event.attemptId,
      childSessionId: attempt.childSessionId ?? null,
      events: [event],
      ...(bound ? { provenStep: label, provenBy: 'attempt_bound' } : {}),
    });
    runner.log(
      `${label}: structured re-arm authorized [${event.code}] on ${event.obligationId} ` +
        `(attempt ${event.attemptId}); ${bound ? 'attempt bound' : 'review acceptance still requires verification'}`,
    );
  }
  runner.settleStructuredRearms(session, label, toolDenialEvents(result.stdout));
  let pendingCodes = [
    ...new Set([
      ...recoverable.filter(
        (code) => NEXT_STEP_RECOVERY_CODES.has(code) && !sameTurnRecovered.includes(code),
      ),
      ...resolvedLaterSuccess,
    ]),
  ];
  const unproven = unprovenOccurrences.filter(
    (code) => isRecoverableFamily(code) && !NEXT_STEP_RECOVERY_CODES.has(code),
  );
  if (unproven.length > 0) {
    throw new DemoNotVerifiedError(
      `${label}: recoverable denial occurrence(s) without a later proven correction (${unproven.join(', ')}); stopping the flow (the proof is NOT_VERIFIED)`,
    );
  }
  // A TICKET_SOURCE_CONFLICT is corrected by the same-turn adoption of the
  // actual ticket; that correction is settled HERE, bound to the persisted
  // ticket identity and the audit sequence (denial -> successful ticket call
  // with a transition -> READY/TICKET selection). A bare later tool success
  // without that witness stays an observation and cannot settle the denial.
  if (pendingCodes.some((code) => TICKET_SOURCE_CONFLICT_CODES.has(code))) {
    const snapshot = runner.requireBoundState(session);
    const command = options.command ?? /^\/([a-z-]+)/.exec(prompt ?? '')?.[1];
    const deniedTools = [
      ...new Set(
        toolDenialEvents(result.stdout)
          .filter((event) => TICKET_SOURCE_CONFLICT_CODES.has(event.code))
          .map((event) => event.tool),
      ),
    ];
    const expected = expectRecovery(
      snapshot.state,
      deniedTools,
      session.terminal,
      recoverableProofs
        .filter((proof) => proof.binding === 'tool')
        .map((proof) => proof.denialIdentity),
      auditFloorBefore,
      toolDenialEvents(result.stdout)
        .filter((event) => event.tool === 'flowguard_ticket')
        .map((event) => event.code),
    );
    if (
      expected.kind === 'ticket_adoption' &&
      recoveryPersisted(
        expected,
        snapshot.state,
        command,
        readAuditEvents(snapshot.sessionDir),
        undefined,
        await runner.transitionAuthority(session.workspace),
      )
    ) {
      session.recoveredDenials.push({
        status: 'proven',
        step: label,
        codes: [...new Set(toolDenialCodes(result.stdout))].filter((code) =>
          TICKET_SOURCE_CONFLICT_CODES.has(code),
        ),
        evidence: 'ticket_adoption',
        expected,
      });
      runner.log(
        `${label}: recovered via bound ticket adoption (digest ${expected.digest.slice(0, 12)}…)`,
      );
      pendingCodes = pendingCodes.filter((code) => !TICKET_SOURCE_CONFLICT_CODES.has(code));
    }
  }
  if (pendingCodes.length > 0) {
    const deniedTools = [
      ...new Set(
        toolDenialEvents(result.stdout)
          .filter((event) => pendingCodes.includes(event.code))
          .map((event) => event.tool),
      ),
    ];
    const validateInvocation =
      deniedTools.length === 1 &&
      (deniedTools[0] === 'flowguard_plan' || deniedTools[0] === 'flowguard_architecture')
        ? await runner.reviewInvocationAuthority(session.workspace)
        : undefined;
    session.awaitingRecovery = {
      step: label,
      codes: pendingCodes,
      denials: toolDenialEvents(result.stdout).filter((event) => pendingCodes.includes(event.code)),
      expected: expectRecovery(
        runner.requireBoundState(session).state,
        deniedTools,
        session.terminal,
        recoverableProofs
          .filter((proof) => proof.binding === 'tool')
          .map((proof) => proof.denialIdentity),
        auditFloorBefore,
        pendingCodes,
        validateInvocation,
      ),
    };
    runner.log(
      `${label}: pending recovery [${pendingCodes.join(', ')}]; the next required step must prove the bound operation`,
    );
  }

  const supersededTerminals = unexpectedDenialCodes(result.stdout).filter((code) =>
    structuredRearmSupersedesTerminal(result.stdout, code),
  );
  if (supersededTerminals.length > 0) {
    session.pendingReviewRecovery = {
      steps: [...(session.pendingReviewRecovery?.steps ?? []), label],
      codes: supersededTerminals,
    };
    runner.log(
      `${label}: terminal block(s) [${supersededTerminals.join(', ')}] superseded by a later structured re-arm; the persisted review outcome is proven at the gate`,
    );
  }

  const planReviewDenied = toolDenialCodes(result.stdout).includes(PLAN_REVIEW_CORRECTION_CODE);
  if (planReviewDenied && !planReviewSameTurnCorrection(result.stdout)) {
    throw new DemoNotVerifiedError(
      `${label}: ${PLAN_REVIEW_CORRECTION_CODE} without a same-turn flowguard_plan correction; stopping the flow (the proof is NOT_VERIFIED)`,
    );
  }
  if (planReviewDenied) {
    session.pendingPlanReviewCorrection = {
      steps: [...(session.pendingPlanReviewCorrection?.steps ?? []), label],
    };
    runner.log(
      `${label}: ${PLAN_REVIEW_CORRECTION_CODE} corrected in-session; reviewer_accepted and iteration consistency are proven at the plan gate`,
    );
  }

  const deniedEvents = toolDenialEvents(result.stdout).filter(
    (event) =>
      !isRecoverableFamily(event.code) &&
      !(planReviewDenied && event.code === PLAN_REVIEW_CORRECTION_CODE) &&
      !supersededTerminals.includes(event.code),
  );
  const unexpected = [];
  for (const denial of deniedEvents) {
    const code = denial.code;
    if (code !== 'HUMAN_DECISION_REQUIRED' || denial.tool !== 'flowguard_decision') {
      unexpected.push(code);
      continue;
    }
    // The agent may not decide on the user's behalf. The refusal is tolerated
    // ONLY with a readable audit witness for THIS call and its full interval.
    // Check every occurrence; a previous refusal cannot excuse a later one.
    const snapshot = runner.requireBoundState(session);
    const call = toolUseEvents(result.stdout).find((event) => event.index === denial.index);
    assertHumanDecisionRefusalUnchanged(
      snapshot.state,
      call,
      auditFloorBefore,
      readAuditEvents(snapshot.sessionDir),
    );
    session.governedRefusals = session.governedRefusals ?? [];
    session.governedRefusals.push({
      step: label,
      code,
      callId: call.callId,
      evidence: 'audit_no_refused_call_mutation',
    });
    runner.log(
      `${label}: HUMAN_DECISION_REQUIRED refused the in-session decision; the current call's audit window proves no mutation — continuing the governed review branch`,
    );
  }
  if (unexpected.length > 0) {
    // The persisted terminal phase is FlowGuard's outcome authority: when the
    // session already reached it, the transport-level block is recorded — never
    // hidden — instead of discarding the completed flow. `denialAfterTerminal`
    // is `true` only when the terminal phase was already persisted BEFORE this
    // turn, which causally places the denial after the transition; otherwise it
    // stays `null` and the ordering is not claimed. Package verification still
    // runs and fails the flow if the required artifact is absent.
    const phaseAfter = runner.currentPhase(session);
    if (phaseAfter === session.terminal) {
      session.terminalBlocks = session.terminalBlocks ?? [];
      session.terminalBlocks.push({
        step: label,
        codes: unexpected,
        phaseBefore,
        phaseAfter,
        denialAfterTerminal: phaseBefore === session.terminal ? true : null,
      });
      runner.log(
        `${label}: terminal block(s) recorded (phaseBefore=${String(phaseBefore)}, phaseAfter=${String(phaseAfter)}) [${unexpected.join(', ')}]`,
      );
    } else {
      let reviewExhausted = false;
      try {
        reviewExhausted = persistedReviewExhausted(runner.requireBoundState(session).state);
      } catch {
        reviewExhausted = false;
      }
      if (reviewExhausted && unexpected.includes('GOVERNANCE_OVERRIDE_REQUIRED')) {
        throw new DemoNotVerifiedError(
          `${label}: independent review exhausted its budget without acceptance ` +
            `(${unexpected.join(', ')}); the positive proof is NOT_VERIFIED`,
        );
      }
      if (classifyUnexpectedBlock(unexpected) === 'not_verified') {
        throw new DemoNotVerifiedError(
          `${label}: review-stage evidence is incomplete (${unexpected.join(', ')}); ` +
            'the positive proof is NOT_VERIFIED',
        );
      }
      throw new Error(
        `${label}: unexpected tool-level block observed (${unexpected.join(', ')}); stopping the flow`,
      );
    }
  }
  return result;
}
