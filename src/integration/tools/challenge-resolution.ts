import { z } from 'zod';

import { resolveActor } from '../../adapters/actor.js';
import { Command, isCommandAllowed } from '../../machine/commands.js';
import type { ChallengeResolution } from '../../state/evidence.js';
import type { SessionState } from '../../state/schema.js';
import type { ToolDefinition } from './helpers.js';
import {
  appendNextAction,
  formatBlocked,
  formatError,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
} from './helpers.js';

/**
 * Validate that `challengeId` names a prior implementation challenge that is
 * eligible for an author resolution: it must exist in the last implementation
 * review findings, have a FAILED outcome (`fail`/`not_verified` — a `pass`
 * challenge was never open, #747), and not already carry a resolution. Returns a
 * blocked tool result, or `null` when the challenge is resolvable.
 */
function checkResolvableChallenge(state: SessionState, challengeId: string): string | null {
  const challenge = state.implReviewFindings
    ?.at(-1)
    ?.challenges?.find(
      (item) => item.challengeId === challengeId && item.kind === 'implementation_challenge',
    );
  if (!challenge) return formatBlocked('IMPLEMENTATION_CHALLENGE_UNKNOWN', { challengeId });
  if (challenge.outcome !== 'fail' && challenge.outcome !== 'not_verified') {
    return formatBlocked('IMPLEMENTATION_CHALLENGE_NOT_FAILED', {
      challengeId,
      outcome: challenge.outcome ?? '',
    });
  }
  if (state.challengeResolutions.some((item) => item.challengeId === challengeId)) {
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
        const challengeBlock = checkResolvableChallenge(state, challengeId);
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
          if (attempt.implementationDigest !== implementation.digest) {
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
          implementationDigest: implementation.digest,
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
