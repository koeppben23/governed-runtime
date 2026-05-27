/**
 * @module integration/tools/ticket-tool
 * @description FlowGuard ticket tool — records task/ticket description for the session.
 *
 * Extracted from simple-tools.ts for single-responsibility compliance.
 *
 * @version v1
 */

import { z } from 'zod';

import type { ToolDefinition } from './helpers.js';
import {
  withMutableSessionTransaction,
  formatBlocked,
  formatError,
  persistAndFormat,
} from './helpers.js';
import type { ToolResult } from './helpers.js';
import { executeTicket } from '../../rails/ticket.js';
import { InputOriginSchema, ExternalReferenceSchema } from '../../state/evidence.js';
import { ActorClaimError } from '../../adapters/actor.js';

// ─── Shared safe-execution wrapper ───────────────────────────────────────────

/**
 * Wraps a tool execution with error handling.
 * ActorClaimError is surfaced as a blocked response when configured.
 */
export async function safeExecute(
  fn: () => Promise<ToolResult>,
  opts: { actorClaimErrorAsBlocked: boolean },
): Promise<ToolResult> {
  try {
    return await fn();
  } catch (err) {
    if (opts.actorClaimErrorAsBlocked && err instanceof ActorClaimError) {
      return formatBlocked(err.code);
    }
    return formatError(err);
  }
}

// ─── flowguard_ticket ────────────────────────────────────────────────────────

export const ticket: ToolDefinition = {
  description:
    'Record the task/ticket description for the FlowGuard session. ' +
    'Clears all downstream evidence (plan, validation, implementation). ' +
    'Allowed in READY and TICKET phases.',
  args: {
    text: z.string().describe('The task or ticket description. Must be non-empty.'),
    source: z
      .enum(['user', 'external'])
      .default('user')
      .describe("Source of the ticket: 'user' (typed in chat) or 'external' (from issue tracker)."),
    inputOrigin: InputOriginSchema.optional().describe(
      'Where the text content originated. Set to "external_reference" when text was extracted ' +
        'from a URL, "manual_text" when typed, "mixed" when both manual and external.',
    ),
    references: z
      .array(ExternalReferenceSchema)
      .optional()
      .describe(
        'External references for this ticket (Jira URL, GitHub issue, Confluence doc, etc.). ' +
          'Each reference has ref (URL/ID), type (ticket/issue/pr/branch/commit/url/doc/other), ' +
          'optional title, source platform, and extractedAt timestamp.',
      ),
  },
  async execute(args, context) {
    return safeExecute(
      async () => {
        return withMutableSessionTransaction(context, async ({ sessDir, state, ctx }) => {
          const result = executeTicket(
            state,
            {
              text: args.text,
              source: args.source,
              inputOrigin: args.inputOrigin,
              references: args.references,
            },
            ctx,
          );
          return persistAndFormat(sessDir, result);
        });
      },
      { actorClaimErrorAsBlocked: true },
    );
  },
};
