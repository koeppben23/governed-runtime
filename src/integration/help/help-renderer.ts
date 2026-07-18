/** @module integration/help/help-renderer */

import type { HelpResult, ProjectedCommand } from './help-projection.js';

function renderCommand(command: ProjectedCommand, verbose: boolean): Record<string, unknown> {
  return {
    invocation: command.invocation,
    description: command.description,
    visibility: command.visibility,
    ...(command.alsoAvailableAs.length > 0 ? { alsoAvailableAs: command.alsoAvailableAs } : {}),
    ...(verbose
      ? {
          id: command.id,
          label: command.label,
          preflight: command.preflight,
        }
      : {}),
  };
}

export function renderHelp(result: HelpResult, verbose: boolean): string {
  return JSON.stringify({
    title: 'FlowGuard Help',
    phase: result.phase?.label ?? null,
    lifecycle: result.lifecycle,
    readiness: result.readiness,
    recommendation: result.recommendation,
    technicalVerification: result.technicalVerification,
    nextAction: result.nextAction ? renderCommand(result.nextAction, verbose) : null,
    commands: result.commands.map((command) => renderCommand(command, verbose)),
  });
}
