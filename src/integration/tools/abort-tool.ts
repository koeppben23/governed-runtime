/**
 * @module integration/tools/abort-tool
 * @description FlowGuard abort_session tool — emergency session termination.
 *
 * Extracted from simple-tools.ts for single-responsibility compliance.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import { withMutableSessionTransaction, persistAndFormat } from './helpers.js';
import { executeAbort } from '../../rails/abort.js';
import { safeExecute } from './ticket-tool.js';

// ─── flowguard_abort_session ─────────────────────────────────────────────────

export const abort_session: ToolDefinition = {
  description:
    'Emergency termination of the FlowGuard session. Bypasses the state machine ' +
    'and directly sets phase to COMPLETE with an ABORTED error marker. ' +
    'Use only when the session cannot or should not continue. Irreversible.',
  args: {
    reason: z
      .string()
      .default('Session aborted by user')
      .describe('Reason for aborting. Recorded in audit trail.'),
  },
  async execute(args, context) {
    return safeExecute(
      async () => {
        return withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
          const result = executeAbort(
            state,
            { reason: args.reason, actor: context.sessionID },
            ctx,
          );
          return persistAndFormat(sessDir, result);
        });
      },
      { actorClaimErrorAsBlocked: false },
    );
  },
};
