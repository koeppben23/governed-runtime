/**
 * @module integration/help/help-projection
 * @description Read-only contextual help projection over canonical runtime state.
 */

import type { FlowGuardPolicy } from '../../config/policy.js';
import { COMMAND_HELP } from '../../machine/command-help.js';
import { isCommandAllowed } from '../../machine/commands.js';
import type { SessionState } from '../../state/schema.js';
import { PHASE_LABELS } from '../../presentation/phase-labels.js';
import { buildStatusProjection, buildFinishCard, type FinishOverallStatus } from '../status.js';
import { evaluateArchivePreflight, type CommandPreflight } from '../archive-preflight.js';
import {
  getInstalledCommand,
  INSTALLED_COMMANDS,
  visibleAliasesForDefinition,
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

export type Readiness = 'ready' | 'ready_with_warnings' | 'blocked' | 'not_verified' | 'none';

export interface ProjectedCommand {
  readonly id: string;
  readonly invocation: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: HelpVisibility;
  readonly preflight: CommandPreflight;
  readonly alsoAvailableAs: readonly string[];
}

export interface TechnicalVerification {
  readonly status: 'verified' | 'not_verified' | 'not_applicable';
  readonly summary: string;
}

export interface ArchiveVerification {
  readonly status: 'not_created' | 'previously_verified' | 'failed' | 'unknown';
  readonly currentSnapshotVerified: boolean;
  readonly summary: string;
}

export interface HelpResult {
  readonly phase: Readonly<{ id: string; label: string }> | null;
  readonly lifecycle: string;
  readonly readiness: Readiness;
  readonly recommendation: string;
  readonly technicalVerification: TechnicalVerification;
  readonly archiveVerification: ArchiveVerification;
  readonly nextAction: ProjectedCommand | null;
  readonly commands: readonly ProjectedCommand[];
}

function description(definition: InstalledCommandDefinition): string {
  if (definition.target.workflowCommand) {
    return COMMAND_HELP[definition.target.workflowCommand].description;
  }
  return definition.description;
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
  if (
    definition.id !== 'workflow.continue' &&
    definition.id !== 'workflow.abort' &&
    definition.target.workflowCommand &&
    !isCommandAllowed(state.phase, definition.target.workflowCommand)
  ) {
    return {
      status: 'not_applicable',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'NOT_APPLICABLE_TO_ACTIVE_FLOW',
      message: 'This command applies to a different workflow or phase.',
      recovery: 'Use the recommended flow commands.',
    };
  }
  return { status: 'available', guarantee: 'eligible_to_attempt' };
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
    alsoAvailableAs: visibleAliasesForDefinition(definition),
  };
}

function visibilityForPreflight(preflightResult: CommandPreflight): HelpVisibility {
  switch (preflightResult.status) {
    case 'available':
      return 'available';
    case 'blocked':
      return 'blocked_recoverable';
    case 'not_applicable':
      return 'not_applicable';
  }
}

function findRecommendation(invocation: string | null): InstalledCommandDefinition | undefined {
  if (!invocation) return undefined;
  return getInstalledCommand(invocation);
}

function finishToReadiness(overallStatus: FinishOverallStatus): Readiness {
  switch (overallStatus) {
    case 'READY':
      return 'ready';
    case 'READY_WITH_WARNINGS':
      return 'ready_with_warnings';
    case 'BLOCKED':
      return 'blocked';
    case 'NOT_VERIFIED':
      return 'not_verified';
    case 'CHANGES_REQUIRED':
      return 'ready_with_warnings';
  }
}

function buildTechnicalVerification(
  state: SessionState | null,
  policy: FlowGuardPolicy | null,
): TechnicalVerification {
  if (!state || !policy)
    return { status: 'not_applicable', summary: 'No session is available to verify.' };
  const finish = buildFinishCard(state, policy);
  if (finish.overallStatus === 'NOT_VERIFIED') {
    return { status: 'not_verified', summary: 'Required evidence is incomplete.' };
  }
  // BLOCKED is a lifecycle/enforcement condition, not evidence deficiency.
  // Technical verification remains independent.
  return { status: 'verified', summary: 'Evidence is complete and verified.' };
}

function buildArchiveVerification(state: SessionState | null): ArchiveVerification {
  if (!state)
    return {
      status: 'unknown',
      currentSnapshotVerified: false,
      summary: 'No session is available for archive verification.',
    };
  if (state.archiveStatus === 'verified') {
    return {
      status: 'previously_verified',
      currentSnapshotVerified: false,
      summary:
        'A previous audit package verification succeeded. Current snapshot freshness is not established.',
    };
  }
  if (state.archiveStatus === 'failed') {
    return {
      status: 'failed',
      currentSnapshotVerified: false,
      summary: 'Audit package verification failed. Inspect status before retrying export.',
    };
  }
  return {
    status: 'not_created',
    currentSnapshotVerified: false,
    summary: 'No audit package has been created yet.',
  };
}

function buildCommandDetail(
  state: SessionState | null,
  policy: FlowGuardPolicy | null,
  requestedInvocation: string,
): HelpResult {
  const definition = getInstalledCommand(requestedInvocation);
  const command = definition
    ? projectCommand(definition, state, visibilityForPreflight(preflight(definition, state)))
    : null;
  return {
    phase: state ? { id: state.phase, label: PHASE_LABELS[state.phase] } : null,
    lifecycle: state ? PHASE_LABELS[state.phase] : 'No active session',
    readiness: 'none',
    recommendation: command ? command.description : 'Unknown FlowGuard command.',
    technicalVerification: buildTechnicalVerification(state, policy),
    archiveVerification: buildArchiveVerification(state),
    nextAction: null,
    commands: command ? [command] : [],
  };
}

function buildNoSessionResult(): HelpResult {
  const hydrate = INSTALLED_COMMANDS.find((definition) => definition.id === 'workflow.hydrate')!;
  const status = INSTALLED_COMMANDS.find((definition) => definition.id === 'operational.status')!;
  return {
    phase: null,
    lifecycle: 'No active session',
    readiness: 'none',
    recommendation: 'Start a governed session.',
    technicalVerification: buildTechnicalVerification(null, null),
    archiveVerification: buildArchiveVerification(null),
    nextAction: projectCommand(hydrate, null, 'recommended'),
    commands: [
      projectCommand(hydrate, null, 'recommended'),
      projectCommand(status, null, 'available'),
    ],
  };
}

function projectActiveCommand(
  definition: InstalledCommandDefinition,
  state: SessionState,
  recommended: InstalledCommandDefinition | undefined,
  scope: 'available' | 'all',
): ProjectedCommand {
  if (definition.id === recommended?.id) {
    const projected = projectCommand(definition, state, 'available');
    return projected.preflight.status === 'available'
      ? { ...projected, visibility: 'recommended' }
      : {
          ...projected,
          visibility: visibilityForPreflight(projected.preflight),
        };
  }
  const availability = preflight(definition, state);
  if (availability.status === 'available') return projectCommand(definition, state, 'available');
  if (scope === 'all')
    return projectCommand(definition, state, visibilityForPreflight(availability));
  return projectCommand(definition, state, 'hidden');
}

function isVisibleInScope(command: ProjectedCommand, scope: 'available' | 'all'): boolean {
  if (scope === 'all') return true;
  if (command.visibility === 'hidden') return false;
  const definition = INSTALLED_COMMANDS.find((candidate) => candidate.id === command.id);
  return definition?.visibility === 'primary';
}

export function buildHelpResult(
  state: SessionState | null,
  policy: FlowGuardPolicy | null,
  opts: {
    view: 'context' | 'commands' | 'command';
    scope?: 'available' | 'all';
    requestedInvocation?: string;
  },
): HelpResult {
  if (opts.requestedInvocation) return buildCommandDetail(state, policy, opts.requestedInvocation);
  if (!state || !policy) return buildNoSessionResult();

  const status = buildStatusProjection(state, policy);
  const finish = buildFinishCard(state, policy);
  const readiness = finishToReadiness(finish.overallStatus);

  const recommended = findRecommendation(status.productNextAction.primaryCommand);
  const candidateNext = recommended ? projectCommand(recommended, state, 'recommended') : null;
  const nextAction =
    candidateNext && candidateNext.preflight.status === 'available' ? candidateNext : null;

  const scope = opts.scope ?? 'available';
  const commands = INSTALLED_COMMANDS.map((definition) =>
    projectActiveCommand(definition, state, recommended, scope),
  ).filter((command) => isVisibleInScope(command, scope));

  const contextCommands = opts.view === 'context' ? limitContextCommands(commands) : commands;

  return {
    phase: { id: state.phase, label: PHASE_LABELS[state.phase] },
    lifecycle: PHASE_LABELS[state.phase],
    readiness,
    recommendation: status.productNextAction.summary,
    technicalVerification: buildTechnicalVerification(state, policy),
    archiveVerification: buildArchiveVerification(state),
    nextAction,
    commands: contextCommands,
  };
}

function limitContextCommands(commands: readonly ProjectedCommand[]): readonly ProjectedCommand[] {
  const recommended = commands.filter((command) => command.visibility === 'recommended');
  const available = commands.filter(
    (command) => command.visibility === 'available' && command.id !== recommended[0]?.id,
  );
  const upcoming = commands
    .filter(
      (command) =>
        command.visibility === 'blocked_recoverable' && command.id !== recommended[0]?.id,
    )
    .slice(0, 2);

  return [...recommended, ...available.slice(0, 5), ...upcoming];
}
