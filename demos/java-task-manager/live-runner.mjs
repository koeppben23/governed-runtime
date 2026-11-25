/** Compose Java demo turns, approval gates and provenance for one isolated run. */
import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { DemoNotVerifiedError } from '../lib/results.mjs';
import { implementationReviewAcceptanceProven, recoveryPersisted } from '../lib/recovery-state.mjs';
import { loadInstalledReviewInvocationValidator } from '../lib/review-recovery-authority.mjs';
import {
  withHost,
  requireHost,
  hostCommand,
  readAudit,
  waitForSessionIdle,
  productStateDigest,
  createHostSession,
  hostNativeCommandTransport,
  hostCommandTransport,
  hostStep,
} from './live-host-transport.mjs';
import { sha256 } from './live-matrix-setup.mjs';
import { planPreflightGate, planReviewCorrectionProven } from './live-plan-preflight.mjs';
import {
  assertSessionBinding,
  readState,
  installedBuild,
  observedTaskChildren,
  exportTranscript,
  captureProvenance,
  verifyPackage,
} from './live-session-evidence.mjs';
import { turn } from './live-turn.mjs';
import {
  hostTurnWasNoOp,
  MAX_IMPLEMENT_REVIEW_RESUMES,
  planCorrectionGateDecision,
  PLAN_REVIEW_CORRECTION_CODE,
  settleRearmObservation,
} from './live-turn-recovery.mjs';

export class Runner {
  constructor(root, options, configDir) {
    this.root = root;
    this.options = options;
    this.configDir = configDir;
    this.workspaces = path.join(root, 'workspaces');
    this.evidenceDir = path.join(root, 'evidence');
    this.logFile = path.join(this.evidenceDir, 'driver.log');
    this.flows = [];
    this.turnObservations = [];
    this.reviewAuthorities = new Map();
    /** @type {Parameters<Parameters<typeof import('../lib/service-lifecycle.mjs').withIsolatedService>[1]>[0] | undefined} */
    this.host = undefined;
  }

  log(message) {
    const line = `${new Date().toISOString()} ${message}`;
    console.log(line);
    fs.appendFileSync(this.logFile, `${line}\n`);
  }

  withHost(use, options) {
    return withHost(this, use, options);
  }

  requireHost() {
    return requireHost(this);
  }

  hostCommand(session, label, name, text) {
    return hostCommand(this, session, label, name, text);
  }

  readAudit(session) {
    return readAudit(this, session);
  }

  waitForSessionIdle(session) {
    return waitForSessionIdle(this, session);
  }

  productStateDigest(workspace) {
    return productStateDigest(this, workspace);
  }

  reviewInvocationAuthority(workspace) {
    if (!this.reviewAuthorities.has(workspace)) {
      this.reviewAuthorities.set(workspace, loadInstalledReviewInvocationValidator(workspace));
    }
    return this.reviewAuthorities.get(workspace);
  }

  createHostSession(session, label) {
    return createHostSession(this, session, label);
  }

  hostNativeCommandTransport(session, label, command) {
    return hostNativeCommandTransport(this, session, label, command);
  }

  hostCommandTransport(session, label, command, options) {
    return hostCommandTransport(this, session, label, command, options);
  }

  hostStep(label, workspace, args, timeoutMs) {
    return hostStep(this, label, workspace, args, timeoutMs);
  }

  turn(session, label, prompt, options) {
    return turn(this, session, label, prompt, options);
  }
  /** Persisted review-progress counters used to prove same-turn wait-state correction. */
  reviewProgress(session) {
    let state;
    try {
      state = this.requireBoundState(session).state;
    } catch {
      return null;
    }
    return {
      planIteration: Number(state?.selfReview?.iteration ?? 0),
      archIterations: (state?.reviewAssurance?.obligations ?? []).filter(
        (item) => item?.obligationType === 'architecture',
      ).length,
      archFindings: Array.isArray(state?.architecture?.reviewFindings)
        ? state.architecture.reviewFindings.length
        : 0,
    };
  }

  /**
   * Resolve a carried recovery against the operation this turn performed. A
   * turn that cannot demonstrate the bound transition stops the flow.
   */
  async settleAwaitingRecovery(session, label, command) {
    if (!session.awaitingRecovery) return;
    const pending = session.awaitingRecovery;
    const after = this.requireBoundState(session).state;
    const validateInvocation =
      pending.expected?.kind === 'subject_approval'
        ? await this.reviewInvocationAuthority(session.workspace)
        : undefined;
    if (!recoveryPersisted(pending.expected, after, command, [], validateInvocation)) {
      throw new DemoNotVerifiedError(
        `${label}: pending recovery [${pending.codes.join(', ')}] was not demonstrated ` +
          'by the authorized affected-operation transition; stopping the flow',
      );
    }
    session.recoveredDenials = session.recoveredDenials ?? [];
    session.recoveredDenials.push({
      status: 'proven',
      step: pending.step,
      codes: pending.codes,
      evidence: `next_step_operation_transition:${label}`,
      expected: pending.expected,
      denials: pending.denials,
    });
    this.log(
      `${pending.step}: recovered by the authorized ${command} operation on its bound subject`,
    );
    session.awaitingRecovery = null;
  }

  /** Advance structured re-arms to proven or failed from the persisted attempt. */
  settleStructuredRearms(session, label, denials = []) {
    const pending = (session.recoveryObservations ?? []).filter(
      (observation) =>
        observation.evidence === 'structured_rearm' &&
        observation.status === 'pending_verification',
    );
    if (pending.length === 0) return;
    let state;
    try {
      state = this.requireBoundState(session).state;
    } catch {
      return;
    }
    for (const observation of pending) {
      settleRearmObservation(observation, state, { label, step: label, denials });
    }
  }

  /** Best-effort persisted phase; `null` when the state is unreadable. */
  currentPhase(session) {
    try {
      return this.requireBoundState(session).state.phase;
    } catch {
      return null;
    }
  }

  /** Digest of the persisted session state; `null` when unreadable. */
  currentStateDigest(session) {
    try {
      const snapshot = this.requireBoundState(session);
      return sha256(path.join(snapshot.sessionDir, 'session-state.json'));
    } catch {
      return null;
    }
  }

  async approve(session, label, expectedPhase) {
    const snapshot = this.requireBoundState(session);
    if (snapshot.state.phase !== expectedPhase) {
      throw new Error(
        `${label}: expected gate ${expectedPhase}, observed ${String(snapshot.state.phase)}`,
      );
    }
    const preflights = (session.recoveryObservations ?? []).filter(
      (observation) =>
        observation.evidence === 'same_turn_plan_preflight_correction' &&
        observation.status === 'pending_verification',
    );
    const expectedPlanGate =
      preflights.length > 0
        ? planPreflightGate(
            snapshot.state,
            session.sessionId,
            await this.reviewInvocationAuthority(session.workspace),
          )
        : null;
    if (preflights.length > 0) {
      if (
        !expectedPlanGate ||
        preflights.some((observation) => !isDeepStrictEqual(expectedPlanGate, observation.gate))
      ) {
        throw new DemoNotVerifiedError(
          `${label}: plan preflight recovery did not reach its bound reviewer_accepted plan gate`,
        );
      }
    }
    if (session.pendingReviewRecovery) {
      const proven =
        expectedPhase === 'PLAN_REVIEW'
          ? planReviewCorrectionProven(snapshot.state)
          : expectedPhase === 'ARCH_REVIEW'
            ? snapshot.state.architecture?.reviewCompletion === 'reviewer_accepted'
            : expectedPhase === 'EVIDENCE_REVIEW'
              ? implementationReviewAcceptanceProven(
                  snapshot.state,
                  await this.reviewInvocationAuthority(session.workspace),
                )
              : false;
      if (!proven) {
        throw new Error(
          `${label}: superseded reviewer block(s) [${session.pendingReviewRecovery.codes.join(', ')}] were not proven by a converged review; stopping the flow`,
        );
      }
      session.recoveredDenials = session.recoveredDenials ?? [];
      session.recoveredDenials.push({
        status: 'proven',
        step: session.pendingReviewRecovery.steps.join(', '),
        codes: session.pendingReviewRecovery.codes,
        evidence: 'structured_rearm_after_terminal_failure',
      });
      this.log(
        `${label}: superseded reviewer block(s) [${session.pendingReviewRecovery.codes.join(', ')}] proven by the converged review`,
      );
      session.pendingReviewRecovery = null;
    }
    if (expectedPhase === 'PLAN_REVIEW' && session.pendingPlanReviewCorrection) {
      const correctionDecision = planCorrectionGateDecision(snapshot.state);
      if (correctionDecision === 'review_exhausted') {
        throw new DemoNotVerifiedError(
          `${label}: independent plan review exhausted its budget without acceptance ` +
            `(${PLAN_REVIEW_CORRECTION_CODE} correction tracked); the positive proof is NOT_VERIFIED`,
        );
      }
      if (correctionDecision !== 'proven') {
        throw new Error(
          `${label}: ${PLAN_REVIEW_CORRECTION_CODE} correction did not persist a consistent reviewer_accepted plan; stopping the flow`,
        );
      }
      session.recoveredDenials = session.recoveredDenials ?? [];
      session.recoveredDenials.push({
        status: 'proven',
        step: session.pendingPlanReviewCorrection.steps.join(', '),
        codes: [PLAN_REVIEW_CORRECTION_CODE],
        evidence: 'same_turn_correction_and_reviewer_accepted',
      });
      this.log(
        `${label}: ${PLAN_REVIEW_CORRECTION_CODE} correction proven by reviewer_accepted at the plan gate`,
      );
      session.pendingPlanReviewCorrection = null;
    }
    const targetPhase =
      expectedPhase === 'PLAN_REVIEW'
        ? 'IMPLEMENTATION'
        : expectedPhase === 'ARCH_REVIEW'
          ? 'ARCH_COMPLETE'
          : expectedPhase === 'EVIDENCE_REVIEW'
            ? 'EXPORT_READY'
            : undefined;
    if (targetPhase === undefined) {
      throw new Error(`${label}: approval from ${expectedPhase} has no allowed target phase`);
    }
    await this.turn(session, label, undefined, {
      command: 'approve',
      expectedTargetPhase: targetPhase,
      ...(expectedPlanGate ? { expectedPlanGate } : {}),
    });
    for (const observation of preflights) {
      observation.status = 'proven';
      observation.provenStep = label;
    }
  }

  /**
   * Drive an outstanding implementation review to EVIDENCE_REVIEW with a
   * BOUNDED number of canonical /implement resumes. The author may end the
   * /implement turn at IMPL_REVIEW without dispatching the reviewer task
   * (observed live); this helper re-enters the real command boundary instead
   * of failing the flow outright. Fail-closed: only IMPL_REVIEW may be
   * resumed, every resume must prove persisted state progress, and the gate
   * must be reached within the bound.
   */
  async completeImplementationReview(session, label, maxResumes = MAX_IMPLEMENT_REVIEW_RESUMES) {
    for (let attempt = 1; attempt <= maxResumes; attempt += 1) {
      const phase = this.currentPhase(session);
      if (phase === 'EVIDENCE_REVIEW') return;
      if (phase !== 'IMPL_REVIEW') {
        if (hostTurnWasNoOp(session.lastTurn, label)) {
          throw new DemoNotVerifiedError(
            `${label}: the host turn produced no tool call and no state change ` +
              `(observed ${String(phase)}); the positive proof is NOT_VERIFIED`,
          );
        }
        throw new Error(
          `${label}: expected IMPL_REVIEW or EVIDENCE_REVIEW, observed ${String(phase)}`,
        );
      }
      const stepLabel = `${label}-resume-${attempt}`;
      const digestBefore = this.currentStateDigest(session);
      const reviewProgressBefore = session.sessionId ? this.reviewProgress(session) : null;
      await this.turn(session, stepLabel, '/implement');
      const digestAfter = this.currentStateDigest(session);
      if (digestAfter === null || digestAfter === digestBefore) {
        if (hostTurnWasNoOp(session.lastTurn, stepLabel)) {
          throw new DemoNotVerifiedError(
            `${stepLabel}: the host turn produced no tool call and no state change; ` +
              'the positive proof is NOT_VERIFIED',
          );
        }
        throw new Error(
          `${stepLabel}: bounded implementation review resume produced no state progress; stopping the flow`,
        );
      }
      session.resumedSteps = session.resumedSteps ?? [];
      session.resumedSteps.push({ step: label, attempt, evidence: 'bounded_resume' });
      this.log(
        `${stepLabel}: implementation review resumed (bounded attempt ${attempt}; state progressed)`,
      );
    }
    const phase = this.currentPhase(session);
    if (phase !== 'EVIDENCE_REVIEW') {
      throw new Error(
        `${label}: implementation review did not reach EVIDENCE_REVIEW within ${maxResumes} bounded resume(s); stopping the flow`,
      );
    }
  }

  requireBoundState(session) {
    const snapshot = readState(this.configDir, session.sessionId);
    if (!snapshot) throw new Error(`no persisted state for ${session.sessionId}`);
    assertSessionBinding(snapshot.state, session.sessionId, session.workspace);
    return snapshot;
  }
  installedBuild(workspace) {
    return installedBuild(this, workspace);
  }

  observedTaskChildren(session) {
    return observedTaskChildren(this, session);
  }

  exportTranscript(label, sessionId, workspace, parentSessionId) {
    return exportTranscript(this, label, sessionId, workspace, parentSessionId);
  }

  captureProvenance(flow, session) {
    return captureProvenance(this, flow, session);
  }

  verifyPackage(session, kind, expectFlow, expectPhase, label) {
    return verifyPackage(this, session, kind, expectFlow, expectPhase, label);
  }
}
