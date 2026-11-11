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
 * - TUI companion metadata: optional TUI commands present in this catalog slice.
 *
 * Desktop command metadata is intentionally outside this catalog slice; it is
 * added by the follow-up Desktop catalog change.
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
  readonly readOnly: boolean;
  readonly requiresSession: boolean;
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
    host: { readOnly: false, requiresSession: true },
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
    host: { readOnly: false, requiresSession: true },
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
    host: { readOnly: false, requiresSession: false },
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
    host: { readOnly: true, requiresSession: false },
    alsoAvailableAs: [],
  },
];

const TUI_CATALOG: readonly CommandCatalogEntry[] = [
  {
    id: 'tui.choose-workflow',
    invocation: '/choose-workflow',
    label: 'Choose workflow or decision',
    description: 'Open the optional TUI canonical Next Action chooser.',
    surfaces: ['tui'],
    maturity: 'stable',
    visibility: 'primary',
    presentationGroup: 'work',
    public: true,
    host: { readOnly: false, requiresSession: true },
    alsoAvailableAs: [],
  },
];

/** Complete composed catalogue for this develop baseline. */
export const COMMAND_CATALOG: readonly CommandCatalogEntry[] = [
  ...INSTALLED_CATALOG,
  ...NATIVE_ONLY_CATALOG,
  ...TUI_CATALOG,
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
