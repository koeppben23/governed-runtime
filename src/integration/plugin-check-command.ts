/**
 * Native /check command. The explicit command callback installs the check scope
 * for one synthetic check turn, runs the canonical check prompt under the
 * build agent (restoring the prior agent afterwards), and clears the scope when
 * the turn reaches idle. No prompt text can mint this authority.
 */
import type { Plugin } from '@opencode/plugin';
import { CHECK_COMMAND } from '../templates/commands/check.js';
import { NATIVE_CHECK_COMMAND } from '../shared/flowguard-identifiers.js';
import { buildEnforcementError } from './blocked-result.js';
import type { ActiveGovernanceScope } from './opencode-governance.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import { getInstalledCommand } from './installed-commands.js';

interface CheckCommandDeps {
  readonly guard: <T>(run: () => Promise<T>) => Promise<T>;
  readonly invoke: <T>(
    sessionId: string,
    run: (entry: {
      readonly runtime: FlowGuardPluginRuntime;
      readonly scope: ActiveGovernanceScope;
    }) => Promise<T>,
    required?: boolean,
  ) => Promise<T | undefined>;
}

type CommandEditor = Parameters<Parameters<Plugin.Context['command']['transform']>[0]>[0];

export function addCheckCommand(
  ctx: Plugin.Context,
  deps: CheckCommandDeps,
  editor: CommandEditor,
): void {
  const command = getInstalledCommand(`/${NATIVE_CHECK_COMMAND}`);
  if (command?.target.nativeCommand !== NATIVE_CHECK_COMMAND)
    throw buildEnforcementError(
      'PLUGIN_ENFORCEMENT_UNAVAILABLE',
      'The native check command metadata is missing or has a non-native target.',
    );
  editor.add({
    name: command.target.nativeCommand,
    description: `FlowGuard — ${command.description}`,
    execute: (input) => deps.guard(() => executeCheckCommand(ctx, deps, input.sessionID)),
  });
}

export async function executeCheckCommand(
  ctx: Plugin.Context,
  deps: CheckCommandDeps,
  sessionID: string,
): Promise<void> {
  await deps.invoke(
    sessionID,
    async ({ runtime, scope }) => {
      if (scope.sessionId !== scope.root.sessionId)
        throw buildEnforcementError(
          'GOVERNANCE_AUTHORITY_BLOCKED',
          'A delegated child cannot run the root /check command.',
        );
      const previousAgent = (await ctx.session.get({ sessionID })).agent ?? 'build';
      const switchAgent = previousAgent !== 'build';
      runtime.activeCommandScopes.set(sessionID, 'check');
      runtime.checkReworkContinuations.delete(sessionID);
      try {
        if (switchAgent) await ctx.session.switchAgent({ sessionID, agent: 'build' });
        await ctx.session.prompt({
          sessionID,
          text: checkPromptBody(),
          metadata: { source: 'flowguard-check-command' },
        });
        await ctx.session.wait({ sessionID });
      } finally {
        runtime.activeCommandScopes.delete(sessionID);
        if (switchAgent) {
          try {
            await ctx.session.switchAgent({ sessionID, agent: previousAgent });
          } catch (error) {
            console.warn('[FlowGuard] /check could not restore the previous agent.', error);
          }
        }
      }
    },
    true,
  );
}

/** The installed template body without frontmatter; the command hook owns execution. */
function checkPromptBody(): string {
  return CHECK_COMMAND.replace(/^---[\s\S]*?---\n+/, '');
}
