/**
 * @module integration/tools/validation/ceremony-decision
 * @description Post-check ceremony decision for IMPL_VALIDATION.
 *
 * The only place a reduced-ceremony decision may be produced. It runs after a
 * check result was merged into the fresh locked state and before auto-advance,
 * so the decision binds the actual delivery:
 *
 * - only when the COMPLETE active-check set has a latest decisive PASS,
 * - only after re-attesting the frozen governed bytes in the worktree,
 * - and only through the single ceremony authority `resolveCeremonyProfile`.
 *
 * Failed or technically blocked checks never reach the authority: they keep
 * the existing error paths and must not appear as regular ceremony denials.
 *
 * @version v1
 */

import { isTechnicalValidationBlock } from '../../../state/evidence-validation.js';
import type { SessionState } from '../../../state/schema.js';
import {
  projectCeremonyEligibility,
  resolveCeremonyProfile,
  type CeremonyProfileDecision,
} from '../../phase-tool-gate.js';
import { evaluateImplValidationEvidence } from '../../../machine/impl-validation-evidence.js';
import {
  flowguardReportArtifacts,
  reattestImplementationSubject,
} from '../../../verification/implementation-subject.js';
import type { SemanticAuditIntent } from '../../audit-outbox.js';

export type PostCheckCeremonyOutcome =
  | {
      readonly kind: 'decided';
      readonly state: SessionState;
      readonly decision: CeremonyProfileDecision;
      /** False when an equivalent final decision was already recorded. */
      readonly isNew: boolean;
    }
  | { readonly kind: 'skipped'; readonly state: SessionState }
  | { readonly kind: 'subject_changed'; readonly expected: string; readonly actual: string };

function latestResultFor(
  state: SessionState,
  checkId: string,
): SessionState['implValidation'][number] | undefined {
  let latest: SessionState['implValidation'][number] | undefined;
  for (const result of state.implValidation) {
    if (result.checkId !== checkId) continue;
    if (latest === undefined || result.executedAt >= latest.executedAt) latest = result;
  }
  return latest;
}

/**
 * Reduced-path-only worktree re-attestation: re-enumerate, scope, compare sets
 * and recompute the digest. Any add, remove, rename or modify after the freeze
 * fails closed. FlowGuard's own per-attempt report files are excluded (narrow,
 * candidate-derived boundary) because they are tool evidence, not
 * implementation bytes.
 */
async function reattestEligibleSubject(
  input: Parameters<typeof decidePostCheckCeremony>[0],
  implementation: NonNullable<SessionState['implementation']>,
): Promise<Extract<PostCheckCeremonyOutcome, { kind: 'subject_changed' }> | null> {
  const reattestation = await reattestImplementationSubject({
    worktree: input.worktree,
    frozenFiles: implementation.changedFiles,
    expectedDigest: implementation.digest,
    baseline: input.state.implementationBaseline,
    digest: input.digest,
    ignoredArtifacts: flowguardReportArtifacts(input.state),
  });
  return reattestation.kind === 'ok'
    ? null
    : {
        kind: 'subject_changed',
        expected: reattestation.expected,
        actual: reattestation.actual,
      };
}

export async function decidePostCheckCeremony(input: {
  readonly state: SessionState;
  readonly worktree: string;
  readonly digest: (text: string) => string;
  readonly now: string;
}): Promise<PostCheckCeremonyOutcome> {
  const { state } = input;
  if (state.phase !== 'IMPL_VALIDATION') return { kind: 'skipped', state };
  const implementation = state.implementation;
  if (implementation === null || state.activeChecks.length === 0) {
    return { kind: 'skipped', state: { ...state, reducedCeremony: null } };
  }

  const latest = state.activeChecks.map((checkId) => latestResultFor(state, checkId));
  // One final decision per implementation cycle: only after the complete check
  // set has a decisive result.
  if (latest.some((result) => result === undefined)) return { kind: 'skipped', state };
  const decisive = latest.filter(
    (result): result is NonNullable<(typeof latest)[number]> => result !== undefined,
  );

  const technicallyBlocked = decisive.some((result) =>
    isTechnicalValidationBlock({
      passed: result.passed,
      outcome: result.outcome,
      timedOut: result.timedOut,
      exitCode: result.exitCode,
      ...(result.assertionExtraction !== undefined
        ? { assertionExtraction: result.assertionExtraction }
        : {}),
    }),
  );
  if (technicallyBlocked || !decisive.every((result) => result.passed)) {
    // Existing failure/error paths own this cycle; clear any earlier decision
    // so no stale reduction survives a later failure.
    return { kind: 'skipped', state: { ...state, reducedCeremony: null } };
  }

  // Canonical completeness is the gate: attempts must still be valid for the
  // current generation (post-resolution, candidate-bound). Incomplete evidence
  // stays PENDING — it is not a final denial.
  if (!evaluateImplValidationEvidence(state).satisfied) {
    return { kind: 'skipped', state };
  }
  const ceremonyInput = { state, changedFiles: implementation.changedFiles };
  // The worktree re-attestation only serves the reduced-ceremony decision. A
  // statically ineligible cycle (feature disabled, non-TRIVIAL claim/surface,
  // blocked risk gate, ...) is denied without touching git: the new safety
  // check must not add blocks to the default full-ceremony path.
  if (
    projectCeremonyEligibility(ceremonyInput).status === 'pending_post_implementation_verification'
  ) {
    const subjectChanged = await reattestEligibleSubject(input, implementation);
    if (subjectChanged !== null) return subjectChanged;
  }

  const decision = resolveCeremonyProfile(ceremonyInput);
  if (decision.profile === 'reduced' && decision.claimedTaskClass !== undefined) {
    return {
      kind: 'decided',
      decision,
      isNew: !sameRecordedDecision(state.reducedCeremony, decision),
      state: {
        ...state,
        reducedCeremony: {
          profile: 'reduced',
          reason: decision.reason,
          claimedTaskClass: decision.claimedTaskClass,
          computedMinimumTaskClass: decision.computedMinimumTaskClass,
          touchedSurfaces: [...decision.touchedSurfaces],
          implementationId: decision.implementationId,
          implementationDigest: decision.implementationDigest,
          policyDigest: decision.policyDigest,
          verificationBasis: decision.verificationBasis,
          decidedAt: input.now,
        },
      },
    };
  }
  return {
    kind: 'decided',
    decision,
    isNew: !denialAlreadyQueued(state, implementation),
    state: { ...state, reducedCeremony: null },
  };
}

function sameRecordedDecision(
  existing: SessionState['reducedCeremony'],
  decision: Extract<CeremonyProfileDecision, { profile: 'reduced' }>,
): boolean {
  if (existing === null) return false;
  if (existing.implementationId !== decision.implementationId) return false;
  if (existing.implementationDigest !== decision.implementationDigest) return false;
  if (existing.policyDigest !== decision.policyDigest) return false;
  const existingAttempts = existing.verificationBasis.attempts
    .map((entry) => `${entry.checkId}:${entry.attemptId}`)
    .sort();
  const nextAttempts = decision.verificationBasis.attempts
    .map((entry) => `${entry.checkId}:${entry.attemptId}`)
    .sort();
  return (
    existingAttempts.length === nextAttempts.length &&
    existingAttempts.every((entry, index) => entry === nextAttempts[index])
  );
}

function denialAlreadyQueued(
  state: SessionState,
  implementation: NonNullable<SessionState['implementation']>,
): boolean {
  return state.pendingAuditOperations.some(
    (operation) =>
      operation.kind === 'semantic' &&
      operation.semantic.event === 'reduced_ceremony_denied' &&
      operation.semantic.detail['implementationId'] === implementation.implementationId,
  );
}

/**
 * Structured audit intent for one final ceremony decision. Emitted for every
 * evaluated cycle (applied or ineligible), never for aborted check runs: a
 * failed or technically blocked check set never reaches the authority.
 */
export function ceremonyAuditIntent(
  decision: CeremonyProfileDecision | null,
  occurredAt: string,
  implementation: SessionState['implementation'],
  isNew: boolean,
): readonly SemanticAuditIntent[] {
  if (decision === null || !isNew) return [];
  if (decision.profile === 'reduced') {
    return [
      {
        phase: 'IMPL_VALIDATION',
        event: 'reduced_ceremony_applied',
        occurredAt,
        detail: {
          status: 'applied',
          reason: decision.reason,
          implementationId: decision.implementationId,
          implementationDigest: decision.implementationDigest,
          policyDigest: decision.policyDigest,
          checkIds: [...decision.verificationBasis.checkIds],
          attemptIds: decision.verificationBasis.attempts.map((entry) => entry.attemptId),
        },
      },
    ];
  }
  return [
    {
      phase: 'IMPL_VALIDATION',
      event: 'reduced_ceremony_denied',
      occurredAt,
      detail: {
        status: 'ineligible',
        reason: decision.reason,
        ...(implementation !== null
          ? {
              implementationId: implementation.implementationId,
              implementationDigest: implementation.digest,
            }
          : {}),
      },
    },
  ];
}
