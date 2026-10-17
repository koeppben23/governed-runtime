/** External persistence witnesses for demo recoveries; no state transitions are synthesized. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DemoNotVerifiedError } from './results.mjs';

function identity(state) {
  return {
    flowguardSessionId: state?.flowguardSessionId,
    hostSessionId: state?.binding?.hostSessionId,
  };
}

/**
 * Ticket source-shape denials. Both are settled ONLY by the same bound ticket
 * adoption witness (persisted digest + audit transition after the denial); the
 * family never widens what counts as proof.
 */
export const TICKET_SOURCE_CONFLICT_CODES = new Set([
  'TICKET_SOURCE_CONFLICT',
  'TICKET_SOURCE_ORIGIN_CONFLICT',
]);

/**
 * Wait-state guards admit nothing on their own: a correction is proven only by
 * the SAME operation succeeding AND the persisted review projection advancing in
 * that turn. `PLAN_REVIEW_IN_PROGRESS` keeps its dedicated plan-gate proof as
 * well; a bare retry never settles either code.
 */
export const WAIT_STATE_RECOVERY_CODES = new Set([
  'ADR_REVIEW_IN_PROGRESS',
  'PLAN_REVIEW_IN_PROGRESS',
]);

/**
 * Demo-side reader for the session audit trail. The witness itself is a plain
 * sequence check over the persisted events; the product's canonical verifier
 * remains the authority for archive and chain validation, which this runner
 * exercises separately.
 */
export function readAuditEvents(sessionDir) {
  let events;
  try {
    events = fs
      .readFileSync(path.join(sessionDir, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch (error) {
    throw new DemoNotVerifiedError(`audit evidence unavailable in ${sessionDir}: ${error.message}`);
  }
  if (
    events.length === 0 ||
    events.some((event) => !event || typeof event !== 'object' || Array.isArray(event))
  ) {
    throw new DemoNotVerifiedError(`audit evidence must contain event objects in ${sessionDir}`);
  }
  return events;
}

/**
 * Prove one refused host decision call, not absence of writes in an arbitrary
 * audit suffix. Unavailable/ambiguous evidence is NOT_VERIFIED; a witnessed
 * mutation is a contract failure, including when the session is now terminal.
 * This checks an external projection, not the product's cryptographic chain.
 */
export function assertHumanDecisionRefusalUnchanged(state, call, auditSequenceFloor, events) {
  const actor = identity(state);
  if (
    typeof actor.flowguardSessionId !== 'string' ||
    actor.flowguardSessionId.length === 0 ||
    typeof actor.hostSessionId !== 'string' ||
    actor.hostSessionId.length === 0 ||
    call?.tool !== 'flowguard_decision' ||
    typeof call.callId !== 'string' ||
    call.callId.length === 0 ||
    !Number.isFinite(call.startedAt) ||
    !Number.isFinite(call.at) ||
    call.startedAt < 0 ||
    call.at < call.startedAt ||
    !Number.isSafeInteger(auditSequenceFloor) ||
    auditSequenceFloor < 0
  ) {
    throw new DemoNotVerifiedError('HUMAN_DECISION_REQUIRED has no bound decision-call interval');
  }
  if (
    events.length === 0 ||
    events.length <= auditSequenceFloor ||
    events.some(
      (event, index) =>
        event?.auditSequence !== index + 1 ||
        event.flowguardSessionId !== actor.flowguardSessionId ||
        (event.hostSessionId !== undefined && event.hostSessionId !== actor.hostSessionId) ||
        typeof event.occurredAt !== 'string' ||
        !Number.isFinite(Date.parse(event.occurredAt)) ||
        typeof event.event !== 'string' ||
        !event.detail ||
        typeof event.detail !== 'object' ||
        Array.isArray(event.detail),
    )
  ) {
    throw new DemoNotVerifiedError(
      'HUMAN_DECISION_REQUIRED has no complete session-bound audit window',
    );
  }
  const matches = events.filter(
    (event) =>
      event.auditSequence > auditSequenceFloor &&
      event.event === 'tool_call:flowguard_decision' &&
      event.hostSessionId === actor.hostSessionId &&
      event.detail.tool === call.tool &&
      event.detail.argsSummary?.sessionID === actor.hostSessionId &&
      event.detail.argsSummary?.callID === call.callId &&
      event.detail.success === false &&
      event.detail.errorCode === 'HUMAN_DECISION_REQUIRED' &&
      event.detail.transitionCount === 0 &&
      Date.parse(event.occurredAt) >= call.startedAt &&
      Date.parse(event.occurredAt) <= call.at,
  );
  if (matches.length !== 1) {
    throw new DemoNotVerifiedError(
      'HUMAN_DECISION_REQUIRED has no unique current-call audit refusal',
    );
  }
  if (
    events.some(
      (event) =>
        event.auditSequence > auditSequenceFloor &&
        (Date.parse(event.occurredAt) >= call.startedAt ||
          event.auditSequence > matches[0].auditSequence) &&
        (event.event === 'state_write' || event.event.startsWith('transition:')),
    )
  ) {
    throw new RefusedDecisionMutationError();
  }
}

class RefusedDecisionMutationError extends Error {
  constructor() {
    super('HUMAN_DECISION_REQUIRED audit window contains a persisted mutation');
    this.name = 'RefusedDecisionMutationError';
    this.code = 'DEMO_REFUSED_DECISION_MUTATION';
  }
}

function acceptingReview(state, type, digest) {
  const assurance = state?.reviewAssurance;
  const obligations = (assurance?.obligations ?? []).filter(
    (item) =>
      item.obligationType === type &&
      item.subjectDigest === digest &&
      item.status === 'consumed' &&
      item.consumedAt != null,
  );
  for (const obligation of obligations.slice().reverse()) {
    const invocation = (assurance?.invocations ?? []).find(
      (item) =>
        item.invocationId === obligation.invocationId &&
        item.obligationId === obligation.obligationId &&
        item.consumedByObligationId === obligation.obligationId &&
        item.capturedVerdict === 'accept' &&
        item.structuredOutputUsed === true,
    );
    const attempt = (assurance?.attempts ?? []).find(
      (item) =>
        item.attemptId === invocation?.attemptId &&
        item.obligationId === obligation.obligationId &&
        item.subjectDigest === digest,
    );
    if (invocation && attempt)
      return {
        obligationId: obligation.obligationId,
        invocationId: invocation.invocationId,
        attemptId: attempt.attemptId,
      };
  }
  return null;
}

/** Canonical ticket content digest: sha256 hex of the ticket text (product `hashText`). */
function ticketContentDigest(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex');
}

/**
 * Persisted proof that the CURRENT implementation review completed: an
 * implementation obligation was consumed by an accept invocation bound to its
 * own invocationId and attempt over the current implementation digest. This is
 * the implementation-recovery completion condition (plan reviews prove
 * reviewer_accepted, implementation reviews prove bound acceptance).
 */
export function implementationReviewAcceptanceProven(state) {
  const digest = state?.implementation?.digest;
  if (typeof digest !== 'string' || digest.length === 0) return false;
  return acceptingReview(state, 'implement', digest) !== null;
}

/** Freeze the affected subject and the exact authorized NEXT operation. */
export function expectRecovery(
  state,
  tools,
  terminal,
  deniedIdentities = [],
  auditSequenceFloor = 0,
  denialCodes = [],
) {
  const actor = identity(state);
  if (tools.length === 1 && tools[0] === 'flowguard_continue' && state?.phase === 'READY') {
    const command =
      terminal === 'COMPLETE'
        ? 'task'
        : terminal === 'ARCH_COMPLETE'
          ? 'architecture'
          : terminal === 'PEER_REVIEW_COMPLETE'
            ? 'review'
            : null;
    return { kind: 'flow_selection', ...actor, command };
  }
  if (tools.length === 1 && tools[0] === 'flowguard_ticket') {
    // A ticket-source correction is the adoption of the actual ticket.
    // The identity is the persisted ticket digest; conflicts or a missing
    // persisted ticket stay unproven. The audit-side transition witness is
    // checked by recoveryPersisted, never here.
    if (
      denialCodes.length === 0 ||
      denialCodes.some((code) => !TICKET_SOURCE_CONFLICT_CODES.has(code)) ||
      deniedIdentities.some((entry) => entry.conflicts.length > 0)
    ) {
      return { kind: 'unproven', ...actor };
    }
    const ticket = state?.ticket;
    if (
      typeof ticket?.digest !== 'string' ||
      ticket.digest.length === 0 ||
      typeof ticket.text !== 'string' ||
      ticket.text.length === 0 ||
      ticketContentDigest(ticket.text) !== ticket.digest
    ) {
      return { kind: 'unproven', ...actor };
    }
    return {
      kind: 'ticket_adoption',
      ...actor,
      command: 'task',
      digest: ticket.digest,
      source: typeof ticket.source === 'string' ? ticket.source : null,
      auditSequenceFloor,
      denialCodes: [...new Set(denialCodes)],
    };
  }
  const kind =
    tools.length === 1 && tools[0] === 'flowguard_plan'
      ? 'plan'
      : tools.length === 1 && tools[0] === 'flowguard_architecture'
        ? 'architecture'
        : null;
  const record = kind === 'plan' ? state?.plan : state?.architecture;
  const subject = kind === 'plan' ? record?.current : record;
  const review = acceptingReview(state, kind, subject?.digest);
  if (!kind || !subject?.digest || !review || record?.reviewCompletion !== 'reviewer_accepted') {
    return { kind: 'unproven', ...actor };
  }
  // A host-supplied identity of Plan A may not be silently rebound to Plan B.
  const claimIds = new Set((record.claimDeclarations?.claims ?? []).map((claim) => claim.claimId));
  if (
    deniedIdentities.some(
      (identity) =>
        identity.conflicts.length > 0 ||
        Object.entries(identity.bindings).some(([type, value]) =>
          type === 'subjectDigest'
            ? value !== subject.digest
            : type === 'obligationId'
              ? value !== review.obligationId
              : type === 'claimId'
                ? !claimIds.has(value)
                : true,
        ),
    )
  ) {
    return { kind: 'unproven', ...actor };
  }
  return {
    kind: 'subject_approval',
    ...actor,
    artifact: kind,
    command: 'approve',
    fromPhase: state.phase,
    digest: subject.digest,
    recordDigest: kind === 'plan' ? subject.recordDigest : null,
    planVersion: kind === 'plan' ? subject.planVersion : null,
    certificateBefore: record.approvalCertificate?.certificateId ?? null,
    review,
  };
}

/**
 * Operation-bound ticket-adoption witness.
 *
 * The persisted ticket must be the exact adopted identity: the stored digest
 * must equal the expected digest AND the SHA-256 of the stored content, so a
 * tampered ticket text can never inherit a trusted digest. The audit trail
 * must show the operational sequence that corrected THIS denial - a failed
 * `flowguard_ticket` call with each observed ticket-source denial code, followed by a
 * successful `flowguard_ticket` call that itself records a transition,
 * followed by the canonical `READY -> TICKET` selection - restricted to the
 * current recovery turn (`auditSequenceFloor`) and the verified FlowGuard
 * session. A state update alone, a historical sequence, or a tampered ticket
 * never counts.
 */
function ticketAdoptionPersisted(expected, state, auditEvents) {
  const ticket = state?.ticket;
  if (state?.phase !== 'TICKET') return false;
  if (typeof ticket?.digest !== 'string' || ticket.digest !== expected.digest) return false;
  if (typeof ticket.text !== 'string' || ticket.text.length === 0) return false;
  if (ticketContentDigest(ticket.text) !== expected.digest) return false;

  const floor = expected.auditSequenceFloor;
  if (
    !Number.isSafeInteger(floor) ||
    floor < 0 ||
    !Array.isArray(expected.denialCodes) ||
    expected.denialCodes.length === 0 ||
    expected.denialCodes.some((code) => !TICKET_SOURCE_CONFLICT_CODES.has(code))
  )
    return false;
  const scoped = auditEvents.filter(
    (event) =>
      Number.isSafeInteger(event?.auditSequence) &&
      event.auditSequence > floor &&
      event?.flowguardSessionId === expected.flowguardSessionId,
  );

  return expected.denialCodes.every((code) => ticketAdoptionAfterDenial(scoped, code));
}

function ticketAdoptionAfterDenial(scoped, code) {
  const denialIndex = scoped.findIndex(
    (event) =>
      event?.event === 'tool_call:flowguard_ticket' &&
      event.detail?.tool === 'flowguard_ticket' &&
      event.detail?.success === false &&
      event.detail?.errorCode === code,
  );
  if (denialIndex === -1) return false;
  const successIndex = scoped.findIndex(
    (event, index) =>
      index > denialIndex &&
      event?.event === 'tool_call:flowguard_ticket' &&
      event.detail?.tool === 'flowguard_ticket' &&
      event.detail?.success === true &&
      typeof event.detail?.transitionCount === 'number' &&
      event.detail.transitionCount > 0,
  );
  if (successIndex === -1) return false;
  return scoped.some(
    (event, index) =>
      index > successIndex &&
      event?.event === 'transition:TICKET_SELECTED' &&
      event.detail?.from === 'READY' &&
      event.detail?.to === 'TICKET' &&
      event.detail?.event === 'TICKET_SELECTED',
  );
}

/** An unrelated phase, audit or metadata update is never an operation witness. */
export function recoveryPersisted(expected, state, command, auditEvents = []) {
  if (
    !expected ||
    expected.command !== command ||
    expected.flowguardSessionId !== state?.flowguardSessionId ||
    expected.hostSessionId !== state?.binding?.hostSessionId
  )
    return false;
  if (typeof expected.flowguardSessionId !== 'string' || typeof expected.hostSessionId !== 'string')
    return false;
  if (expected.kind === 'ticket_adoption') {
    return ticketAdoptionPersisted(expected, state, auditEvents);
  }
  if (expected.kind === 'flow_selection') {
    if (command === 'task')
      return (
        state.phase === 'TICKET' &&
        typeof state.ticket?.digest === 'string' &&
        state.ticket.digest.length > 0
      );
    const type =
      command === 'architecture' ? 'architecture' : command === 'review' ? 'review' : null;
    return (
      type !== null &&
      (state.reviewAssurance?.obligations ?? []).some(
        (item) =>
          item.obligationType === type &&
          item.status === 'pending' &&
          typeof item.subjectDigest === 'string' &&
          item.subjectDigest.length > 0,
      )
    );
  }
  if (expected.kind !== 'subject_approval') return false;
  const record = state?.[expected.artifact];
  const subject = expected.artifact === 'plan' ? record?.current : record;
  const certificate = record?.approvalCertificate;
  const review = acceptingReview(state, expected.artifact, expected.digest);
  if (
    !review ||
    !certificate ||
    state.phase === expected.fromPhase ||
    certificate.certificateId === expected.certificateBefore
  )
    return false;
  return (
    subject?.digest === expected.digest &&
    (expected.artifact !== 'plan' ||
      (subject.recordDigest === expected.recordDigest &&
        subject.planVersion === expected.planVersion &&
        certificate.planRecordDigest === expected.recordDigest &&
        certificate.planVersion === expected.planVersion)) &&
    record.reviewCompletion === 'reviewer_accepted' &&
    certificate.authorityDigest === expected.digest &&
    certificate.reviewBinding?.kind === 'current_review' &&
    certificate.reviewBinding.reviewedSubjectDigest === expected.digest &&
    certificate.reviewBinding.reviewObligationId === expected.review.obligationId &&
    review.obligationId === expected.review.obligationId &&
    review.invocationId === expected.review.invocationId &&
    review.attemptId === expected.review.attemptId
  );
}
