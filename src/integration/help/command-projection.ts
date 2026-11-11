/** Read-only command projection and display eligibility. Never an execution authority. */
import { isCommandAllowed } from '../../machine/commands.js';
import type { SessionState } from '../../state/schema.js';
import { evaluateArchivePreflight, type CommandPreflight } from '../archive-preflight.js';
import type { InstalledCommandDefinition } from '../installed-commands.js';
import {
  TOOL_FLOWGUARD_ARCHIVE,
  TOOL_FLOWGUARD_CONTINUE,
  TOOL_FLOWGUARD_HELP,
  TOOL_FLOWGUARD_STATUS,
} from '../tool-names.js';
import { NATIVE_START_COMMAND } from '../../shared/flowguard-identifiers.js';
import { projectEvidenceApprovalBlock } from '../status/status-detail-projections.js';
import { IntegrationInvariantError } from '../errors.js';
import {
  commandAvailability,
  getCatalogCommand,
  type CapabilityMap,
  type CommandAvailability,
  type CommandCatalogEntry,
  type CommandMaturity,
  type HelpCapabilities,
  type HostSurface,
} from './command-catalog.js';

export type HelpVisibility =
  | 'recommended'
  | 'available'
  | 'blocked_recoverable'
  | 'not_verified'
  | 'host_unavailable'
  | 'not_applicable'
  | 'hidden';

export interface ProjectedCommand {
  readonly id: string;
  readonly invocation: string;
  readonly label: string;
  readonly description: string;
  readonly visibility: HelpVisibility;
  readonly preflight: CommandPreflight;
  readonly alsoAvailableAs: readonly string[];
  readonly surfaces: readonly HostSurface[];
  readonly maturity: CommandMaturity;
  readonly capabilities: CapabilityMap;
  readonly availability: CommandAvailability;
}

function installedPreflight(
  definition: InstalledCommandDefinition,
  state: SessionState | null,
): CommandPreflight {
  if (definition.target.nativeCommand === NATIVE_START_COMMAND)
    return { status: 'available', guarantee: 'eligible_to_attempt' };
  if (definition.target.toolName === TOOL_FLOWGUARD_ARCHIVE) return evaluateArchivePreflight(state);
  if (
    definition.target.toolName === TOOL_FLOWGUARD_STATUS ||
    definition.target.toolName === TOOL_FLOWGUARD_HELP
  ) {
    return { status: 'available', guarantee: 'read_only_available' };
  }
  if (!state) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'SESSION_REQUIRED',
      message: 'This command requires a FlowGuard session.',
      recovery:
        'Only verified inactivity permits explicit host Start; missing or damaged bound authority must be restored, not recreated.',
    };
  }
  const operation = explicitOperationPreflight(definition, state);
  if (operation) return operation;
  if (
    definition.target.workflowCommand &&
    !isCommandAllowed(state.phase, definition.target.workflowCommand)
  ) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'WORKFLOW_COMMAND_NOT_ALLOWED',
      message: 'This command is not available in the current phase.',
      recovery: 'Follow the recommended next action.',
    };
  }
  return (
    approvalPreflight(definition, state) ?? {
      status: 'available',
      guarantee: 'eligible_to_attempt',
    }
  );
}

/** Display eligibility only; native admission remains in the ACTIVE-root callback. */
function explicitOperationPreflight(
  definition: InstalledCommandDefinition,
  state: SessionState,
): CommandPreflight | null {
  if (definition.target.toolName === TOOL_FLOWGUARD_CONTINUE) {
    if (state.phase === 'READY')
      return {
        status: 'blocked',
        guarantee: 'eligible_to_attempt',
        reasonCode: 'CONTINUE_AMBIGUOUS',
        message: 'Continue requires a selected workflow. Choose a flow first.',
        recovery: 'Run /task, /architecture, or /review to select a flow.',
      };
    // Read-only at gates/terminal phases too; never the old mutating rail.
    return { status: 'available', guarantee: 'read_only_available' };
  }
  if (definition.target.nativeCommand !== undefined)
    return { status: 'available', guarantee: 'eligible_to_attempt' };
  return null;
}

function approvalPreflight(
  definition: InstalledCommandDefinition,
  state: SessionState,
): CommandPreflight | null {
  if (definition.intent !== 'approve') return null;
  const block = projectEvidenceApprovalBlock(state);
  if (!block) return null;
  return {
    status: 'blocked',
    guarantee: 'eligible_to_attempt',
    reasonCode: block.code,
    message: block.reason,
    recovery: block.recovery.join('\n'),
  };
}

export function catalogPreflight(
  entry: CommandCatalogEntry,
  state: SessionState | null,
): CommandPreflight {
  if (entry.installed) return installedPreflight(entry.installed, state);
  if (!entry.host) {
    throw new IntegrationInvariantError(
      'COMMAND_CATALOG_ENTRY_INVALID',
      `Command catalog entry ${entry.id} has neither installed metadata nor host metadata.`,
    );
  }
  // Host-session presence is a host-side precondition (`requiresHostSession`)
  // and cannot be verified from this projection. Only the FlowGuard session
  // state is authoritative here.
  if (entry.host.requiresGovernanceSession && !state) {
    return {
      status: 'blocked',
      guarantee: 'eligible_to_attempt',
      reasonCode: 'SESSION_REQUIRED',
      message: 'This command requires a FlowGuard session.',
      recovery: 'Run /start to activate a session.',
    };
  }
  return entry.host.readOnly
    ? { status: 'available', guarantee: 'read_only_available' }
    : { status: 'available', guarantee: 'eligible_to_attempt' };
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

export function projectCatalogCommand(
  entry: CommandCatalogEntry,
  state: SessionState | null,
  capabilities: HelpCapabilities,
  recommendedInvocation: string | null,
): ProjectedCommand {
  const availability = commandAvailability(entry, capabilities);
  const preflight = catalogPreflight(entry, state);
  const visibility: HelpVisibility =
    availability === 'host_unavailable'
      ? 'host_unavailable'
      : availability === 'not_verified'
        ? 'not_verified'
        : entry.invocation === recommendedInvocation && preflight.status === 'available'
          ? 'recommended'
          : visibilityForPreflight(preflight);
  return {
    id: entry.id,
    invocation: entry.invocation,
    label: entry.label,
    description: entry.description,
    visibility,
    preflight,
    alsoAvailableAs: entry.alsoAvailableAs,
    surfaces: entry.surfaces,
    maturity: entry.maturity,
    capabilities,
    availability,
  };
}

export function findRecommendation(invocation: string | null): CommandCatalogEntry | undefined {
  if (!invocation) return undefined;
  return getCatalogCommand(invocation);
}
