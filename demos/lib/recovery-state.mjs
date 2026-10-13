/** External persistence witnesses for demo recoveries; no state transitions are synthesized. */

function identity(state) {
  return {
    flowguardSessionId: state?.flowguardSessionId,
    hostSessionId: state?.binding?.hostSessionId,
  };
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

/** Freeze the affected subject and the exact authorized NEXT operation. */
export function expectRecovery(state, tools, terminal, deniedIdentities = []) {
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

/** An unrelated phase, audit or metadata update is never an operation witness. */
export function recoveryPersisted(expected, state, command) {
  if (
    !expected ||
    expected.command !== command ||
    expected.flowguardSessionId !== state?.flowguardSessionId ||
    expected.hostSessionId !== state?.binding?.hostSessionId
  )
    return false;
  if (typeof expected.flowguardSessionId !== 'string' || typeof expected.hostSessionId !== 'string')
    return false;
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
