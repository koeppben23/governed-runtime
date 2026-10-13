/**
 * @module demos/lib/control-oracles
 * @description Shared external oracles for the live controls. They verify the
 * canonical persisted state; they are not a second proof authority.
 *
 * @version v1
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

/**
 * A denied approval must leave no completion package and no completion evidence.
 */
export function assertNoCompletionPackage(runner, session) {
  const snapshot = runner.requireBoundState(session);
  const archiveDir = path.join(path.dirname(snapshot.sessionDir), 'archive');
  const produced = fs.existsSync(archiveDir)
    ? fs.readdirSync(archiveDir).filter((file) => file.includes(session.sessionId))
    : [];
  if (produced.length > 0) {
    throw new Error(`a denied approval produced completion package(s): ${produced.join(', ')}`);
  }
  if (snapshot.state.exportCompletionEvidence != null) {
    throw new Error('a denied approval persisted export completion evidence');
  }
  return { archiveDir, produced };
}

function sameAssertion(identity, expected) {
  return identity?.providerId === expected.providerId && identity?.localId === expected.localId;
}

function assertionOf(attempt, expected) {
  return attempt?.result?.assertionExtraction?.assertions?.find((candidate) =>
    sameAssertion(candidate.assertion, expected),
  );
}

function attemptIdsOf(refs) {
  return (refs ?? [])
    .filter((ref) => ref?.kind === 'validation_attempt')
    .map((ref) => ref.attemptId);
}

/**
 * The full proof-evidence contract for a certificate-bound critical fact:
 * contract/certificate binding, a fresh PROVEN projection, both real checks
 * green from distinct attempts, both explicitly bound assertions observed with
 * the role-specific status, and non-crossed evidence roles.
 */
export function assertProofEvidence(state, options) {
  const {
    claimId,
    positiveAssertion,
    adversarialAssertion,
    mode,
    expectPhase = 'EVIDENCE_REVIEW',
  } = options;
  const contract = state.proofContract?.claims?.find((claim) => claim.claimId === claimId);
  if (!contract || contract.signalClass !== 'fact' || contract.critical !== true) {
    throw new Error('the retained claim is not materialized as a governing critical fact');
  }
  const certificate = state.plan?.approvalCertificate;
  const authority = contract.provenance;
  if (
    !certificate ||
    authority?.kind !== 'canonical_authority' ||
    authority.authorityId !== 'plan' ||
    authority.digest !== state.plan.current.digest ||
    authority.approval?.certificateId !== certificate.certificateId ||
    authority.approval.declarationId !== claimId
  ) {
    throw new Error('the critical fact lacks its current plan certificate binding');
  }

  const projected = state.proofGraph?.claims?.find((claim) => claim.claimId === claimId);
  if (mode === 'negative') {
    if (projected?.verificationState === 'PROVEN') {
      throw new Error(
        `unexpected claim verification state: ${String(projected?.verificationState)}`,
      );
    }
  } else if (
    !projected ||
    projected.verificationState !== 'PROVEN' ||
    projected.freshness?.stale !== false ||
    projected.freshness?.boundDigest !== state.implementation?.digest
  ) {
    throw new Error(
      `expected a fresh PROVEN claim bound to the current implementation, observed ${String(projected?.verificationState)}`,
    );
  }

  const attempts = (state.validationAttempts ?? []).filter(
    (attempt) => attempt.scope === 'implementation',
  );
  const build = attempts.filter((attempt) => attempt.result.checkId === 'build').at(-1);
  const test = attempts.filter((attempt) => attempt.result.checkId === 'test').at(-1);
  if (
    !build?.result.passed ||
    build.result.exitCode !== 0 ||
    !test?.result.passed ||
    test.result.exitCode !== 0
  ) {
    throw new Error('both real implementation checks must be green');
  }
  if (build.attemptId === test.attemptId) {
    throw new Error('positive and adversarial evidence must come from distinct attempts');
  }

  if (assertionOf(test, positiveAssertion)?.status !== 'passed') {
    throw new Error('the bound positive assertion must be passed and fresh');
  }
  const expectedAdversarial = mode === 'negative' ? 'skipped' : 'passed';
  if (assertionOf(build, adversarialAssertion)?.status !== expectedAdversarial) {
    throw new Error(`the bound adversarial assertion must be ${expectedAdversarial}`);
  }

  const evidenceAttemptIds = attemptIdsOf(projected.evidenceRefs);
  const counterexampleAttemptIds = attemptIdsOf(projected.counterexampleRefs);
  if (!evidenceAttemptIds.includes(test.attemptId)) {
    throw new Error('the positive evidence does not reference the checked test attempt');
  }
  if (!counterexampleAttemptIds.includes(build.attemptId)) {
    throw new Error('the counterexample evidence does not reference the checked build attempt');
  }
  if (
    evidenceAttemptIds.includes(build.attemptId) ||
    counterexampleAttemptIds.includes(test.attemptId)
  ) {
    throw new Error(
      'the evidence roles are not independent: a checked attempt is cross-referenced',
    );
  }

  if (expectPhase && state.phase !== expectPhase) {
    throw new Error(`expected ${expectPhase}, observed ${String(state.phase)}`);
  }
  return { claimId, buildAttemptId: build.attemptId, testAttemptId: test.attemptId };
}
