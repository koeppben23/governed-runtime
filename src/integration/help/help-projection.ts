/**
 * @module integration/help/help-projection
 * @description Read-only contextual help projection over canonical runtime state.
 */

import type { FlowGuardPolicy } from '../../config/policy.js';
import { COMMAND_HELP } from '../../machine/command-help.js';
import { isCommandAllowed } from '../../machine/commands.js';
import type { SessionState } from '../../state/schema.js';
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { buildStatusProjection } from '../status.js';
import { evaluateArchivePreflight, type CommandPreflight } from '../archive-preflight.js';
import {
  getInstalledCommand,
  INSTALLED_COMMANDS,
  type InstalledCommandDefinition,
} from '../installed-commands.js';
import {
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_HYDRATE,
  TOOL_FLOWGUARD_STATUS,
} from '../tool-names.js';

export type HelpVisibility =
  'recommended' | 'available' | 'upcoming' | 'blocked_recoverable' | 'not_applicable' | 'hidden';

export interface ProjectedCommand {
  readonly id: string;
  readonly invocation: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: HelpVisibility;
  readonly preflight: CommandPreflight;
  readonly alsoAvailableAs: readonly string[];
}

export interface HelpResult {
  readonly phase: Readonly<{ id: string; label: string }> | null;
  readonly lifecycle: string;
  readonly recommendation: string;
  readonly technicalVerification: string;
  readonly nextAction: ProjectedCommand | null;
  readonly commands: readonly ProjectedCommand[];
}

const OPERATIONAL_DESCRIPTIONS: Readonly<Partial<Record<string, string>>> = {
  'operational.status': 'Show the current phase and next action.',
  'operational.archive': 'Create and verify the audit package.',
  'alias.export': 'Create and verify the audit package.',
  'operational.finish': 'Show completion readiness without changing the workflow.',
  'alias.why': 'Explain the current runtime blocker.',
  'operational.help.context': 'Show concise help for the current situation.',
  'operational.help.commands': 'List FlowGuard commands for the current context.',
};

function description(definition: InstalledCommandDefinition): string {
  if (definition.target.workflowCommand) {
    return COMMAND_HELP[definition.target.workflowCommand].description;
  }
  return OPERATIONAL_DESCRIPTIONS[definition.id] ?? 'Run this FlowGuard command.';
}

function label(definition: InstalledCommandDefinition): string {
  if (definition.target.workflowCommand)
    return COMMAND_HELP[definition.target.workflowCommand].label;
  return definition.invocation;
}

function preflight(
  definition: InstalledCommandDefinition,
  state: SessionState | null,
): CommandPreflight {
  if (definition.target.toolName === TOOL_FLOWGUARD_ARCHIVE) return evaluateArchivePreflight(state);
  if (
    definition.target.toolName === TOOL_FLOWGUARD_STATUS ||
    definition.target.toolName === TOOL_FLOWGUARD_HELP
  ) {
    return { status: 'available', guarantee: 'read_only_available' };
  }
  if (definition.target.toolName === TOOL_FLOWGUARD_HYDRATE) {
    return { status: 'available', guarantee: 'eligible_to_attempt' };
  }
  if (!state) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'SESSION_REQUIRED',
      message: 'This command requires a FlowGuard session.',
      recovery: 'Run /hydrate to initialize a session.',
    };
  }
  // /continue and /abort intentionally retain terminal tool semantics even though
  // the machine predicate denies all lifecycle commands at terminal phases.
  if (
    definition.id !== 'workflow.continue' &&
    definition.id !== 'workflow.abort' &&
    definition.target.workflowCommand &&
    !isCommandAllowed(state.phase, definition.target.workflowCommand)
  ) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'WORKFLOW_COMMAND_NOT_ALLOWED',
      message: 'This workflow command is not eligible in the current phase.',
      recovery: 'Follow the recommended next action.',
    };
  }
  return { status: 'available', guarantee: 'eligible_to_attempt' };
}

function aliases(definition: InstalledCommandDefinition): readonly string[] {
  if (definition.target.toolName !== TOOL_FLOWGUARD_ARCHIVE) return [];
  return definition.invocation === '/export' ? ['/archive'] : ['/export'];
}

function projectCommand(
  definition: InstalledCommandDefinition,
  state: SessionState | null,
  visibility: HelpVisibility,
): ProjectedCommand {
  return {
    id: definition.id,
    invocation: definition.invocation,
    label: label(definition),
    description: description(definition),
    visibility,
    preflight: preflight(definition, state),
    alsoAvailableAs: aliases(definition),
  };
}

function visibilityForPreflight(preflightResult: CommandPreflight): HelpVisibility {
  return preflightResult.status === 'available' ? 'available' : 'blocked_recoverable';
}

function findRecommendation(invocation: string | null): InstalledCommandDefinition | undefined {
  if (!invocation) return undefined;
  return getInstalledCommand(invocation);
}

function technicalVerification(state: SessionState | null): string {
  if (!state) return 'No session is available to verify.';
  if (state.archiveStatus === 'verified') {
    return 'A previous audit package verification succeeded. Current snapshot freshness is not established.';
  }
  if (state.archiveStatus === 'failed')
    return 'Audit package verification failed. Inspect status before retrying export.';
  return 'No audit package verification has been recorded.';
}

export function buildHelpResult(
  state: SessionState | null,
  policy: FlowGuardPolicy | null,
  opts: { scope: 'available' | 'all'; requestedInvocation?: string },
): HelpResult {
  if (opts.requestedInvocation) {
    const definition = getInstalledCommand(opts.requestedInvocation);
    const command = definition
      ? projectCommand(definition, state, visibilityForPreflight(preflight(definition, state)))
      : null;
    return {
      phase: state ? { id: state.phase, label: PHASE_LABELS[state.phase] } : null,
      lifecycle: state ? PHASE_LABELS[state.phase] : 'No active session',
      recommendation: command ? command.description : 'Unknown FlowGuard command.',
      technicalVerification: technicalVerification(state),
      nextAction: command,
      commands: command ? [command] : [],
    };
  }

  if (!state || !policy) {
    const hydrate = INSTALLED_COMMANDS.find((definition) => definition.id === 'workflow.hydrate')!;
    const status = INSTALLED_COMMANDS.find((definition) => definition.id === 'operational.status')!;
    return {
      phase: null,
      lifecycle: 'No active session',
      recommendation: 'Start a governed session.',
      technicalVerification: technicalVerification(null),
      nextAction: projectCommand(hydrate, null, 'recommended'),
      commands: [
        projectCommand(hydrate, null, 'recommended'),
        projectCommand(status, null, 'available'),
      ],
    };
  }

  const status = buildStatusProjection(state, policy);
  const recommended = findRecommendation(status.productNextAction.primaryCommand);
  const recommendedCommand = recommended ? projectCommand(recommended, state, 'recommended') : null;
  const commands = INSTALLED_COMMANDS.map((definition) => {
    if (definition.id === recommended?.id) return projectCommand(definition, state, 'recommended');
    const availability = preflight(definition, state);
    if (availability.status === 'available') return projectCommand(definition, state, 'available');
    return projectCommand(
      definition,
      state,
      opts.scope === 'all' ? 'blocked_recoverable' : 'hidden',
    );
  }).filter((command) => {
    if (opts.scope === 'all') return true;
    const definition = INSTALLED_COMMANDS.find((candidate) => candidate.id === command.id);
    return command.visibility !== 'hidden' && definition?.visibility === 'primary';
  });

  return {
    phase: { id: state.phase, label: PHASE_LABELS[state.phase] },
    lifecycle: PHASE_LABELS[state.phase],
    recommendation: status.productNextAction.summary,
    technicalVerification: technicalVerification(state),
    nextAction: recommendedCommand,
    commands,
  };
}
