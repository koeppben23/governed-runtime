/**
 * @module integration/help/command-catalog
 * @description Capability-aware documentation catalogue for FlowGuard commands.
 *
 * This is a projection for help and documentation only. It is not a command
 * execution authority and does not change machine admissibility, policy,
 * activation, review or decision semantics.
 *
 * Sources:
 * - INSTALLED_COMMANDS: installed/portable slash-command identities.
 * - NATIVE_PLUGIN_COMMANDS: native OpenCode plugin registrations.
 * - TUI/Desktop companion metadata: optional host-surface commands.
 *
 * Desktop entries are documentation only. The server-side help projection
 * cannot verify that the Desktop GUI or any optional GUI API is loaded; those
 * surfaces therefore remain `not_verified` unless a trusted host supplies a
 * capability snapshot.
 */

import {
  INSTALLED_COMMANDS,
  visibleAliasesForDefinition,
  type InstalledCommandDefinition,
  type PresentationGroup,
} from '../installed-commands.js';
import { COMMAND_HELP } from '../../machine/command-help.js';
import {
  NATIVE_DEBUG_EXPORT_COMMAND,
  NATIVE_DIAGNOSTICS_COMMAND,
  NATIVE_END_GOVERNANCE_COMMAND,
  NATIVE_RECOVER_CAPACITY_COMMAND,
} from '../../shared/flowguard-identifiers.js';

export type HostSurface = 'portable' | 'native' | 'tui' | 'desktop';
export type CapabilityState = 'supported' | 'unsupported' | 'not_verified';
export type CommandMaturity = 'stable' | 'experimental';
export type CommandAvailability = 'available' | 'host_unavailable' | 'not_verified';

export type CapabilityMap = Readonly<Record<HostSurface, CapabilityState>>;

export interface HelpCapabilities {
  readonly portable: CapabilityState;
  readonly native: CapabilityState;
  readonly tui: CapabilityState;
  readonly desktop: CapabilityState;
}

/**
 * No host-specific support is inferred by default. The portable surface is the
 * installed command/help baseline that ships with this package. The native
 * plugin can add `native: 'supported'` from its own registration composition;
 * MCP and other callers must leave host-specific surfaces not_verified.
 */
export const DEFAULT_HELP_CAPABILITIES: HelpCapabilities = {
  portable: 'supported',
  native: 'not_verified',
  tui: 'not_verified',
  desktop: 'not_verified',
};

interface HostCommandMetadata {
  /**
   * No persistent data changes. Volatile UI state and read-only RPC calls are
   * allowed; this does not mean the command has no observable side effects.
   */
  readonly readOnly: boolean;
  /** Requires a FlowGuard session state (for example, after /start). */
  readonly requiresGovernanceSession: boolean;
  /**
   * Requires an OpenCode host session. This is documentation only: the help
   * projection cannot verify host-session presence and must not block on it.
   */
  readonly requiresHostSession: boolean;
}

export interface CommandCatalogEntry {
  readonly id: string;
  readonly invocation: string;
  readonly label: string;
  readonly description: string;
  readonly surfaces: readonly HostSurface[];
  readonly maturity: CommandMaturity;
  readonly visibility: InstalledCommandDefinition['visibility'];
  readonly presentationGroup: PresentationGroup;
  readonly public: boolean;
  readonly installed?: InstalledCommandDefinition;
  readonly host?: HostCommandMetadata;
  readonly alsoAvailableAs: readonly string[];
}

function installedLabel(definition: InstalledCommandDefinition): string {
  if (definition.target.workflowCommand)
    return COMMAND_HELP[definition.target.workflowCommand].label;
  return definition.invocation;
}

function installedDescription(definition: InstalledCommandDefinition): string {
  if (definition.target.workflowCommand)
    return COMMAND_HELP[definition.target.workflowCommand].description;
  return definition.description;
}

function installedSurfaces(definition: InstalledCommandDefinition): readonly HostSurface[] {
  // Installed templates are portable. Definitions without a template are only
  // registered by the native plugin (start/check/decision commands).
  return definition.templateFile === null ? ['native'] : ['portable'];
}

const INSTALLED_CATALOG: readonly CommandCatalogEntry[] = INSTALLED_COMMANDS.map((definition) => ({
  id: definition.id,
  invocation: definition.invocation,
  label: installedLabel(definition),
  description: installedDescription(definition),
  surfaces: installedSurfaces(definition),
  maturity: 'stable',
  visibility: definition.visibility,
  presentationGroup: definition.presentationGroup,
  public: true,
  installed: definition,
  alsoAvailableAs: visibleAliasesForDefinition(definition),
}));

const NATIVE_ONLY_CATALOG: readonly CommandCatalogEntry[] = [
  {
    id: 'native.recover-capacity',
    invocation: `/${NATIVE_RECOVER_CAPACITY_COMMAND}`,
    label: 'Recover reviewer capacity',
    description:
      'Release a proven terminal reviewer capacity lock; never unlocks an unknown outcome.',
    surfaces: ['native'],
    maturity: 'stable',
    visibility: 'compatibility',
    presentationGroup: 'recovery',
    public: true,
    host: { readOnly: false, requiresGovernanceSession: true, requiresHostSession: true },
    alsoAvailableAs: [],
  },
  {
    id: 'native.end-governance',
    invocation: `/${NATIVE_END_GOVERNANCE_COMMAND}`,
    label: 'End governance',
    description: 'End opt-in governance after safe workflow, reviewer and audit closure.',
    surfaces: ['native'],
    maturity: 'stable',
    visibility: 'compatibility',
    presentationGroup: 'recovery',
    public: true,
    host: { readOnly: false, requiresGovernanceSession: true, requiresHostSession: true },
    alsoAvailableAs: [],
  },
  {
    id: 'native.debug-export',
    invocation: `/${NATIVE_DEBUG_EXPORT_COMMAND}`,
    label: 'Export diagnostics',
    description: 'Create the bounded, redacted native diagnostic snapshot for the current session.',
    surfaces: ['native'],
    maturity: 'stable',
    visibility: 'primary',
    presentationGroup: 'information',
    public: true,
    host: { readOnly: false, requiresGovernanceSession: false, requiresHostSession: true },
    alsoAvailableAs: [],
  },
  {
    id: 'native.diagnostics',
    invocation: `/${NATIVE_DIAGNOSTICS_COMMAND}`,
    label: 'Show diagnostics',
    description: 'Render bounded, read-only Explorer, review, log and notification views.',
    surfaces: ['native'],
    maturity: 'stable',
    visibility: 'primary',
    presentationGroup: 'information',
    public: true,
    host: { readOnly: true, requiresGovernanceSession: false, requiresHostSession: true },
    alsoAvailableAs: [],
  },
];

const COMPANION_CATALOG: readonly CommandCatalogEntry[] = [
  {
    id: 'companion.choose-workflow',
    invocation: '/choose-workflow',
    label: 'Choose workflow or decision',
    description: 'Open the optional TUI or Desktop canonical Next Action chooser.',
    surfaces: ['tui', 'desktop'],
    maturity: 'stable',
    visibility: 'primary',
    presentationGroup: 'work',
    public: true,
    host: { readOnly: false, requiresGovernanceSession: false, requiresHostSession: true },
    alsoAvailableAs: [],
  },
  {
    id: 'desktop.ui-probe',
    invocation: '/flowguard-ui-probe',
    label: 'Open FlowGuard Workbench',
    description: 'Open the read-only Desktop review, evidence and recovery Workbench.',
    surfaces: ['desktop'],
    maturity: 'experimental',
    visibility: 'primary',
    presentationGroup: 'information',
    public: true,
    host: { readOnly: true, requiresGovernanceSession: false, requiresHostSession: true },
    alsoAvailableAs: [],
  },
  {
    id: 'desktop.inline-status',
    invocation: '/flowguard-inline',
    label: 'Inspect status beside chat',
    description: 'Refresh the read-only Desktop composer status; never inserts a message.',
    surfaces: ['desktop'],
    maturity: 'experimental',
    visibility: 'primary',
    presentationGroup: 'information',
    public: true,
    host: { readOnly: true, requiresGovernanceSession: false, requiresHostSession: true },
    alsoAvailableAs: [],
  },
];

/** Complete composed catalogue for this develop baseline. */
export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
  ...INSTALLED_CATALOG,
  ...NATIVE_ONLY_CATALOG,
  ...COMPANION_CATALOG,
];

export function getCatalogCommand(invocation: string): CommandCatalogEntry | undefined {
  return COMMAND_CATALOG.find((entry) => entry.invocation === invocation);
}

export function commandAvailability(
  entry: CommandCatalogEntry,
  capabilities: CapabilityMap,
): CommandAvailability {
  const states = entry.surfaces.map((surface) => capabilities[surface]);
  if (states.includes('supported')) return 'available';
  if (states.includes('not_verified')) return 'not_verified';
  return 'host_unavailable';
}
