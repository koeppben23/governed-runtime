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
import { resolveCeremonyProfile, type CeremonyProfileDecision } from '../../phase-tool-gate.js';
import { computeImplementationDigest } from '../../../verification/implementation-subject.js';

export type PostCheckCeremonyOutcome =
  | {
      readonly kind: 'decided';
      readonly state: SessionState;
      readonly decision: CeremonyProfileDecision;
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

  // The decision must bind the bytes actually in the worktree, not a stale
  // file list. Any add/remove/rename/modify after the freeze fails closed.
  const actual = await computeImplementationDigest({
    worktree: input.worktree,
    files: implementation.changedFiles,
    digest: input.digest,
  });
  if (actual !== implementation.digest) {
    return { kind: 'subject_changed', expected: implementation.digest, actual };
  }

  const decision = resolveCeremonyProfile({ state, changedFiles: implementation.changedFiles });
  if (decision.profile === 'reduced' && decision.claimedTaskClass !== undefined) {
    return {
      kind: 'decided',
      decision,
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
  return { kind: 'decided', decision, state: { ...state, reducedCeremony: null } };
}
