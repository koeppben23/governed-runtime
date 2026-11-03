/**
 * Native /check command. The command installs the explicit check scope for the
 * synthetic check turn, then lets the existing model/tool loop execute the
 * canonical run_check and review workflow. The scope is cleared when that turn
 * reaches idle; no provider/model or tool is bypassed.
 */
import type { Plugin } from '@opencode/plugin';
import { CHECK_COMMAND } from '../templates/commands/check.js';
import { NATIVE_CHECK_COMMAND } from '../shared/flowguard-identifiers.js';
import { buildEnforcementError } from './blocked-result.js';
import type { ActiveGovernanceScope } from './opencode-governance.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';

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
  editor.add({
    name: NATIVE_CHECK_COMMAND,
    description:
      'FlowGuard — run the canonical verification checks and review loop for the current implementation.',
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
      runtime.activeCommandScopes.set(sessionID, 'check');
      runtime.checkReworkContinuations.delete(sessionID);
      try {
        await ctx.session.synthetic({
          sessionID,
          text: checkPromptBody(),
          resume: true,
          metadata: { source: 'flowguard-check-command' },
        });
        await ctx.session.wait({ sessionID });
      } finally {
        runtime.activeCommandScopes.delete(sessionID);
      }
    },
    true,
  );
}

/** The installed template body without frontmatter; the command hook owns execution. */
function checkPromptBody(): string {
  return CHECK_COMMAND.replace(/^---[\s\S]*?---\n+/, '');
}
