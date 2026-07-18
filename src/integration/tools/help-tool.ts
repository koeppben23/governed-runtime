/**
 * @module integration/tools/help-tool
 * @description Read-only context-sensitive help projection.
 */

import { z } from 'zod';
import type { ToolDefinition } from './helpers.js';
import { formatError, withReadOnlySession } from './helpers.js';
import { buildHelpResult } from '../help/help-projection.js';
import { renderHelp } from '../help/help-renderer.js';

const HelpArgsSchema = z.discriminatedUnion('view', [
  z.object({ view: z.literal('context'), verbose: z.boolean().optional() }).strict(),
  z
    .object({
      view: z.literal('commands'),
      scope: z.enum(['available', 'all']),
      verbose: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      view: z.literal('command'),
      command: z.string().min(1),
      verbose: z.boolean().optional(),
    })
    .strict(),
]);

export const help: ToolDefinition = {
  description:
    'Read-only context-sensitive FlowGuard help. Use view=context for /help, view=commands ' +
    'with scope=available or all for /commands, and view=command with a command name for details.',
  args: {
    view: z.enum(['context', 'commands', 'command']),
    scope: z.enum(['available', 'all']).optional(),
    command: z.string().min(1).optional(),
    verbose: z.boolean().optional(),
  },
  async execute(args, context) {
    try {
      const parsed = HelpArgsSchema.safeParse(args);
      if (!parsed.success) {
        return JSON.stringify({
          error: true,
          message: 'Use context, commands with scope, or command with a command name.',
        });
      }
      const session = await withReadOnlySession(context);
      const view = parsed.data;
      const result = buildHelpResult(session.state, session.policy, {
        view: view.view,
        scope: view.view === 'commands' ? view.scope : undefined,
        ...(view.view === 'command'
          ? { requestedInvocation: `/${view.command.replace(/^\/+/, '')}` }
          : {}),
      });
      return renderHelp(result, view.verbose ?? false);
    } catch (err) {
      return formatError(err);
    }
  },
};
