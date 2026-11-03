/**
 * @module integration/plugin-command-scope
 * @description Native V2 replacement for the removed V1 command-before scope
 * hook. The installed /check prompt is recognized by its stable marker; every
 * later root prompt clears the scope and the check rework continuation latch.
 */

import { CHECK_COMMAND_MARKER } from '../templates/commands/check.js';
import type { FlowGuardPluginRuntime } from './plugin-shared.js';
import type { ActiveGovernanceScope } from './opencode-governance.js';

export function updateRootPromptScope(
  runtime: FlowGuardPluginRuntime,
  scope: ActiveGovernanceScope,
  promptText: unknown,
): void {
  if (typeof promptText !== 'string') return;
  if (scope.sessionId === scope.root.sessionId)
    updateCommandScope(runtime, scope.root.sessionId, promptText);
}

export function updateCommandScope(
  runtime: FlowGuardPluginRuntime,
  sessionId: string,
  promptText: string,
): void {
  runtime.checkReworkContinuations.delete(sessionId);
  if (promptText.includes(CHECK_COMMAND_MARKER))
    runtime.activeCommandScopes.set(sessionId, 'check');
  else runtime.activeCommandScopes.delete(sessionId);
}
