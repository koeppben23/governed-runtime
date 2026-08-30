import { z } from 'zod';
import { Command, isCommandAllowed } from '../../machine/commands.js';
import { resolveActorForPolicy } from '../../adapters/actor-context.js';
import { ActorIdentityError } from '../../adapters/actor.js';
import { consumeImplementationReviewExtensionIntent } from '../user-decision-intent.js';
import { formatError } from './error-format.js';
import {
  formatBlocked,
  withMutableSession,
  withMutableSessionTransaction,
  writeStateWithArtifacts,
  type ToolDefinition,
} from './helpers.js';

export const extend_implementation_review: ToolDefinition = {
  description:
    'Open a finite, user-authorized extension to an exhausted implementation review budget. ' +
    'This does not record implementation evidence or submit a review verdict.',
  args: {
    additionalIterations: z
      .number()
      .int()
      .positive()
      .finite()
      .describe(
        'Positive finite number of additional independent review iterations authorized by the user.',
      ),
  },
  async execute(args, context) {
    try {
      const probe = await withMutableSession(context);
      if (!isCommandAllowed(probe.state.phase, Command.EXTEND_IMPLEMENTATION_REVIEW)) {
        return formatBlocked('COMMAND_NOT_ALLOWED', {
          command: '/extend-implementation-review',
          phase: probe.state.phase,
        });
      }
      if (!probe.state.implementationRework?.exhausted) {
        return formatBlocked('IMPLEMENTATION_REVIEW_NOT_EXHAUSTED');
      }
      const actor = await resolveActorForPolicy(
        context.worktree || context.directory,
        probe.policy,
      );

      return await withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
        if (!isCommandAllowed(state.phase, Command.EXTEND_IMPLEMENTATION_REVIEW)) {
          return formatBlocked('COMMAND_NOT_ALLOWED', {
            command: '/extend-implementation-review',
            phase: state.phase,
          });
        }
        if (!state.implementationRework?.exhausted) {
          return formatBlocked('IMPLEMENTATION_REVIEW_NOT_EXHAUSTED');
        }
        const intent = consumeImplementationReviewExtensionIntent({
          sessionId: context.sessionID,
          additionalIterations: args.additionalIterations,
        });
        if (!intent.ok) {
          return formatBlocked('HUMAN_DECISION_REQUIRED', { reason: intent.reason });
        }
        const authorizedBy = {
          actorId: actor.id,
          actorEmail: actor.email,
          actorDisplayName: actor.displayName,
          actorSource: actor.source,
          actorAssurance: actor.assurance,
        } as const;
        const nextState = {
          ...state,
          implementationRework: { ...state.implementationRework, exhausted: false },
          implementationReviewExtensions: [
            ...state.implementationReviewExtensions,
            {
              additionalIterations: args.additionalIterations,
              authorizedAt: ctx.now(),
              authorizedBy,
            },
          ],
        };
        const persisted = await writeStateWithArtifacts(sessDir, nextState);
        return JSON.stringify({
          phase: persisted.phase,
          additionalIterations: args.additionalIterations,
          status:
            'Implementation review budget extension authorized. Re-recording remains a separate implementation action.',
        });
      });
    } catch (err) {
      if (err instanceof ActorIdentityError)
        return formatBlocked(err.code, { reason: err.message });
      return formatError(err);
    }
  },
};
