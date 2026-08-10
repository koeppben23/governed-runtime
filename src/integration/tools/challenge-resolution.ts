import { z } from 'zod';

import { resolveActor } from '../../adapters/actor.js';
import { Command, isCommandAllowed } from '../../machine/commands.js';
import type { ChallengeResolution } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import type { ToolDefinition } from './helpers.js';
import { isOpenImplementationChallenge } from './implement-review.js';
import {
  appendNextAction,
  formatBlocked,
  formatError,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
} from './helpers.js';

/** True if `challengeId` ever appeared as an implementation_challenge in the history. */
function challengeEverRecorded(state: SessionState, challengeId: string): boolean {
  return (state.implReviewFindings ?? []).some((findings) =>
    (findings.challenges ?? []).some(
      (item) => item.challengeId === challengeId && item.kind === 'implementation_challenge',
    ),
  );
}

/**
 * Validate that `challengeId` names an implementation challenge eligible for an
 * author resolution against the current digest (#747 multi-round lifecycle):
 *
 *  - it must exist somewhere in the implementation review history
 *    (else UNKNOWN);
 *  - it must currently be OPEN across the lifecycle — a failing-origin challenge
 *    whose latest independent verdict is not `resolved` (else NOT_FAILED: it was
 *    never failing, or it has already been independently resolved). Open-state is
 *    derived from the whole history, not just the latest `challenges[]`, so a
 *    challenge a later reviewer marked `still_failing`/`not_verified` — and which
 *    is therefore no longer re-emitted as a challenge object — remains
 *    resolvable;
 *  - it must not already have a resolution for THIS implementation digest
 *    (append-only: a new digest with fresh passing attempts may be resolved
 *    again). Returns a blocked tool result, or `null` when resolvable.
 */
function checkResolvableChallenge(
  state: SessionState,
  challengeId: string,
  implementationDigest: string,
): string | null {
  if (!challengeEverRecorded(state, challengeId)) {
    return formatBlocked('IMPLEMENTATION_CHALLENGE_UNKNOWN', { challengeId });
  }
  if (!isOpenImplementationChallenge(state, challengeId)) {
    return formatBlocked('IMPLEMENTATION_CHALLENGE_NOT_FAILED', { challengeId });
  }
  if (
    state.challengeResolutions.some(
      (item) =>
        item.challengeId === challengeId && item.implementationDigest === implementationDigest,
    )
  ) {
    return formatBlocked('IMPLEMENTATION_CHALLENGE_ALREADY_RESOLVED', { challengeId });
  }
  return null;
}

export const resolve_implementation_challenge: ToolDefinition = {
  description:
    'Record advisory evidence resolving one prior implementation review challenge. ' +
    'Available only in IMPL_REVIEW after post-implementation validation; it never changes review acceptance.',
  args: {
    challengeId: z.string().uuid().describe('ID of one prior implementation_challenge.'),
    validationAttemptIds: z
      .array(z.string().uuid())
      .min(1)
      .describe('Immutable post-implementation validation attempt IDs for the current digest.'),
  },
  async execute(args, context) {
    try {
      return await withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
        const challengeId = args.challengeId as string;
        const attemptIds = args.validationAttemptIds as string[];
        if (!isCommandAllowed(state.phase, Command.RESOLVE_IMPLEMENTATION_CHALLENGE)) {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/resolve-implementation-challenge',
            phase: state.phase,
          });
        }
        const implementation = state.implementation;
        if (!implementation) return formatBlocked('IMPLEMENTATION_EVIDENCE_REQUIRED');
        const challengeBlock = checkResolvableChallenge(
          state,
          challengeId,
          implementation.candidate.candidateDigest,
        );
        if (challengeBlock) return challengeBlock;
        if (new Set(attemptIds).size !== attemptIds.length) {
          return formatBlocked('IMPLEMENTATION_VALIDATION_ATTEMPT_DUPLICATE', {
            attemptId: 'duplicate input',
          });
        }
        for (const attemptId of attemptIds) {
          const attempt = state.validationAttempts.find((item) => item.attemptId === attemptId);
          if (!attempt)
            return formatBlocked('IMPLEMENTATION_VALIDATION_ATTEMPT_UNKNOWN', { attemptId });
          if (attempt.scope !== 'implementation') {
            return formatBlocked('IMPLEMENTATION_VALIDATION_ATTEMPT_WRONG_SCOPE', { attemptId });
          }
          if (attempt.implementationDigest !== implementation.candidate.candidateDigest) {
            return formatBlocked('IMPLEMENTATION_VALIDATION_ATTEMPT_DIGEST_MISMATCH', {
              attemptId,
            });
          }
          if (!attempt.result.passed) {
            return formatBlocked('IMPLEMENTATION_VALIDATION_ATTEMPT_FAILED', { attemptId });
          }
        }
        let author: ChallengeResolution['author'];
        try {
          author = await resolveActor(state.binding.worktree);
        } catch {
          // Identity is advisory provenance; absence must not prevent evidence recording.
          author = undefined;
        }
        const resolution: ChallengeResolution = {
          challengeId,
          implementationDigest: implementation.candidate.candidateDigest,
          validationAttemptIds: attemptIds,
          resolvedAt: ctx.now(),
          ...(author ? { author } : {}),
        };
        const nextState = {
          ...state,
          challengeResolutions: [...state.challengeResolutions, resolution],
        };
        await writeStateWithArtifacts(sessDir, nextState);
        return appendNextAction(
          JSON.stringify({
            phase: nextState.phase,
            status:
              'Implementation challenge resolution recorded as advisory NOT_VERIFIED evidence.',
            challengeResolution: resolution,
            advisory:
              'NOT_VERIFIED: this evidence does not alter implementation-review acceptance.',
          }),
          nextState,
        );
      });
    } catch (error) {
      return formatError(error);
    }
  },
};
