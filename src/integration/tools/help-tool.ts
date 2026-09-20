/**
 * @module integration/tools/help-tool
 * @description Read-only context-sensitive help projection.
 */

import { z } from 'zod';
import type { ToolDefinition } from './helpers.js';
import { formatError } from './error-format.js';
import { formatBlocked, withReadOnlySession } from './helpers.js';
import { readReport } from '../../adapters/persistence.js';
import { readConfig } from '../../adapters/persistence-config.js';
import { buildHelpResult } from '../help/help-projection.js';
import { renderHelp } from '../help/help-renderer.js';

const HelpArgsSchema = z.discriminatedUnion('view', [
  z
    .object({
      view: z.literal('context'),
      verbose: z.boolean().optional(),
      includeArtifactContent: z.boolean().optional(),
    })
    .strict(),
  z
    .object({
      view: z.literal('commands'),
      scope: z.enum(['available', 'all']),
      verbose: z.boolean().optional(),
      includeArtifactContent: z.boolean().optional(),
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
    'with scope=available or all for /commands, and view=command with a command name for details. ' +
    'For resume after compaction, set includeArtifactContent: true to retrieve full ticket and plan text.',
  args: {
    view: z.enum(['context', 'commands', 'command']),
    scope: z.enum(['available', 'all']).optional(),
    command: z.string().min(1).optional(),
    verbose: z.boolean().optional(),
    includeArtifactContent: z.boolean().optional(),
  },
  async execute(args, context) {
    try {
      const parsed = HelpArgsSchema.safeParse(args);
      if (!parsed.success) {
        return formatBlocked('HELP_ARGUMENTS_INVALID');
      }
      return executeHelp(parsed.data, context);
    } catch (err) {
      return formatError(err);
    }
  },
};

function resolveArtifactContentPreference(view: z.infer<typeof HelpArgsSchema>): boolean {
  if (view.view === 'command') return false;
  return view.includeArtifactContent ?? false;
}

function resolveRequestedInvocation(view: z.infer<typeof HelpArgsSchema>): string | undefined {
  return view.view === 'command' ? `/${view.command.replace(/^\/+/, '')}` : undefined;
}

async function executeHelp(
  view: z.infer<typeof HelpArgsSchema>,
  context: Parameters<ToolDefinition['execute']>[1],
): Promise<string> {
  const glyphProfile = (await readConfig(context.worktree || context.directory)).presentation
    .opencode.glyphProfile;
  const session = await withReadOnlySession(context);
  const reviewReport = session.sessDir
    ? ((await readReport(session.sessDir)) ?? undefined)
    : undefined;
  const includeArtifactContent = resolveArtifactContentPreference(view);
  const requestedInvocation = resolveRequestedInvocation(view);
  const result = buildHelpResult(session.state, session.policy, {
    view: view.view,
    ...(view.view === 'commands' && view.scope !== undefined ? { scope: view.scope } : {}),
    ...(reviewReport !== undefined ? { reviewReport } : {}),
    ...(requestedInvocation !== undefined ? { requestedInvocation } : {}),
    includeArtifactContent,
  });
  return renderHelp(result, {
    format: view.verbose ? 'json' : 'markdown',
    verbose: view.verbose ?? false,
    glyphProfile,
    includeArtifactContent,
  });
}
