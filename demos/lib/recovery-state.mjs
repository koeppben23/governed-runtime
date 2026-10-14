/** External persistence witnesses for demo recoveries; no state transitions are synthesized. */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

function identity(state) {
  return {
    flowguardSessionId: state?.flowguardSessionId,
    hostSessionId: state?.binding?.hostSessionId,
  };
}

/**
 * Demo-side reader for the session audit trail. The witness itself is a plain
 * sequence check over the persisted events; the product's canonical verifier
 * remains the authority for archive and chain validation, which this runner
 * exercises separately.
 */
export function readAuditEvents(sessionDir) {
  try {
    return fs
      .readFileSync(path.join(sessionDir, 'audit.jsonl'), 'utf8')
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line));
  } catch {
    return [];
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

/** Freeze the affected subject and the exact authorized NEXT operation. */
export function expectRecovery(state, tools, terminal, deniedIdentities = [], auditSequenceFloor = 0) {
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
    // A TICKET_SOURCE_CONFLICT correction is the adoption of the actual ticket.
    // The identity is the persisted ticket digest; conflicts or a missing
    // persisted ticket stay unproven. The audit-side transition witness is
    // checked by recoveryPersisted, never here.
    if (deniedIdentities.some((entry) => entry.conflicts.length > 0)) {
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
 * `flowguard_ticket` call with TICKET_SOURCE_CONFLICT, followed by a
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

  const floor =
    typeof expected.auditSequenceFloor === 'number' && Number.isFinite(expected.auditSequenceFloor)
      ? expected.auditSequenceFloor
      : 0;
  const scoped = auditEvents.filter(
    (event) =>
      (Number(event?.auditSequence) || 0) > floor &&
      event?.flowguardSessionId === expected.flowguardSessionId,
  );

  const denialIndex = scoped.findIndex(
    (event) =>
      event?.event === 'tool_call:flowguard_ticket' &&
      event.detail?.tool === 'flowguard_ticket' &&
      event.detail?.success === false &&
      event.detail?.errorCode === 'TICKET_SOURCE_CONFLICT',
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
