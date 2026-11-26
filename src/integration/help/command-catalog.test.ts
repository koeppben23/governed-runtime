import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  COMMAND_CATALOG,
  DEFAULT_HELP_CAPABILITIES,
  commandAvailability,
  type CommandCatalogEntry,
  type HelpCapabilities,
} from './command-catalog.js';
import { catalogPreflight } from './command-projection.js';
import { INSTALLED_COMMANDS } from '../installed-commands.js';
import {
  NATIVE_CATALOGUED_COMMANDS,
  NATIVE_PLUGIN_COMMANDS,
} from '../../shared/flowguard-identifiers.js';
import { GUI_PLUGIN_BUNDLE } from '../../templates/wrappers/gui-plugin-bundle.js';

const docs = [
  readFileSync(new URL('../../../docs/commands.md', import.meta.url), 'utf8'),
  readFileSync(new URL('../../../docs/desktop.md', import.meta.url), 'utf8'),
].join('\n');

const desktopBundleInvocations = [...GUI_PLUGIN_BUNDLE.matchAll(/slash: \{ name: '([^']+)' \}/g)]
  .map((match) => `/${match[1]}`)
  .sort();

function entry(invocation: string): CommandCatalogEntry {
  const found = COMMAND_CATALOG.find((candidate) => candidate.invocation === invocation);
  if (!found) throw new TypeError(`catalog fixture missing: ${invocation}`);
  return found;
}

function capabilities(overrides: Partial<HelpCapabilities> = {}): HelpCapabilities {
  return { ...DEFAULT_HELP_CAPABILITIES, ...overrides };
}

describe('command catalog', () => {
  it('keeps command ids and invocations unique', () => {
    const ids = COMMAND_CATALOG.map((candidate) => candidate.id);
    const invocations = COMMAND_CATALOG.map((candidate) => candidate.invocation);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(invocations).size).toBe(invocations.length);
  });

  it('represents every native plugin command and preserves catalogued parity', () => {
    const catalogInvocations = new Set(COMMAND_CATALOG.map((candidate) => candidate.invocation));
    const installedInvocations = new Set(
      INSTALLED_COMMANDS.map((candidate) => candidate.invocation),
    );

    for (const command of NATIVE_PLUGIN_COMMANDS)
      expect(catalogInvocations, command).toContain(`/${command}`);
    for (const command of NATIVE_CATALOGUED_COMMANDS)
      expect(installedInvocations, command).toContain(`/${command}`);
    for (const definition of INSTALLED_COMMANDS) {
      const native = definition.target.nativeCommand;
      if (native !== undefined) expect(NATIVE_PLUGIN_COMMANDS, definition.id).toContain(native);
      if (definition.templateFile === null)
        expect(NATIVE_CATALOGUED_COMMANDS, definition.id).toContain(definition.invocation.slice(1));
    }
  });

  it('catalogs exactly the Desktop commands registered by the GUI bundle', () => {
    const catalogDesktopInvocations = COMMAND_CATALOG.filter((candidate) =>
      candidate.surfaces.includes('desktop'),
    )
      .map((candidate) => candidate.invocation)
      .sort();

    expect(catalogDesktopInvocations).toEqual(desktopBundleInvocations);
    expect(entry('/choose-workflow').surfaces).toEqual(['tui', 'desktop']);
    expect(entry('/flowguard-ui-probe').surfaces).toEqual(['desktop']);
    expect(entry('/flowguard-inline').surfaces).toEqual(['desktop']);
  });

  it('keeps Desktop-only commands out of portable, native and TUI surfaces', () => {
    for (const invocation of ['/flowguard-ui-probe', '/flowguard-inline']) {
      expect(entry(invocation).surfaces).toEqual(['desktop']);
    }
  });

  it('derives surfaces from template installation and native registration', () => {
    expect(entry('/status').surfaces).toEqual(['portable']);
    expect(entry('/task').surfaces).toEqual(['portable']);
    expect(entry('/start').surfaces).toEqual(['native']);
    expect(entry('/approve').surfaces).toEqual(['native']);
    expect(entry('/diagnostics').surfaces).toEqual(['native']);
  });

  it('labels experimental Desktop commands without changing availability semantics', () => {
    expect(entry('/flowguard-ui-probe')).toMatchObject({
      maturity: 'experimental',
      public: true,
      host: {
        readOnly: true,
        requiresGovernanceSession: false,
        requiresHostSession: true,
      },
    });
    expect(entry('/flowguard-inline')).toMatchObject({
      maturity: 'experimental',
      public: true,
      host: {
        readOnly: true,
        requiresGovernanceSession: false,
        requiresHostSession: true,
      },
    });
    expect(entry('/choose-workflow')).toMatchObject({
      maturity: 'stable',
      host: {
        readOnly: false,
        requiresGovernanceSession: false,
        requiresHostSession: true,
      },
    });
  });

  it('uses no persistent-data-change semantics for readOnly', () => {
    expect(entry('/diagnostics').host?.readOnly).toBe(true);
    expect(entry('/flowguard-ui-probe').host?.readOnly).toBe(true);
    expect(entry('/flowguard-inline').host?.readOnly).toBe(true);
    expect(entry('/debug-export').host?.readOnly).toBe(false);
    expect(entry('/choose-workflow').host?.readOnly).toBe(false);
  });

  it('handles supported, unsupported and unverified capabilities distinctly', () => {
    const diagnostics = entry('/diagnostics');
    expect(commandAvailability(diagnostics, capabilities({ native: 'supported' }))).toBe(
      'available',
    );
    expect(commandAvailability(diagnostics, DEFAULT_HELP_CAPABILITIES)).toBe('not_verified');
    expect(commandAvailability(diagnostics, capabilities({ native: 'unsupported' }))).toBe(
      'host_unavailable',
    );
  });

  it('aggregates /choose-workflow availability across TUI and Desktop', () => {
    const chooser = entry('/choose-workflow');
    const matrix = [
      ['supported', 'not_verified', 'available'],
      ['unsupported', 'supported', 'available'],
      ['not_verified', 'not_verified', 'not_verified'],
      ['not_verified', 'unsupported', 'not_verified'],
      ['unsupported', 'unsupported', 'host_unavailable'],
    ] as const;
    for (const [tui, desktop, expected] of matrix) {
      expect(
        commandAvailability(chooser, capabilities({ tui, desktop })),
        `${tui}/${desktop}`,
      ).toBe(expected);
    }
  });

  it('maps Desktop-only command availability from the desktop surface only', () => {
    // Injected capability states prove the projection contract, not live GUI
    // registration or the presence of optional Panel/Slot/ComposerPill APIs.
    for (const invocation of ['/flowguard-ui-probe', '/flowguard-inline']) {
      const command = entry(invocation);
      expect(commandAvailability(command, capabilities({ desktop: 'supported' }))).toBe(
        'available',
      );
      expect(commandAvailability(command, DEFAULT_HELP_CAPABILITIES)).toBe('not_verified');
      expect(commandAvailability(command, capabilities({ desktop: 'unsupported' }))).toBe(
        'host_unavailable',
      );
    }
  });

  it('separates host-session from governance-session preconditions', () => {
    for (const invocation of ['/choose-workflow', '/flowguard-ui-probe', '/flowguard-inline']) {
      expect(catalogPreflight(entry(invocation), null)).toMatchObject({
        status: 'available',
      });
    }
    expect(catalogPreflight(entry('/flowguard-ui-probe'), null)).toMatchObject({
      guarantee: 'read_only_available',
    });
    expect(catalogPreflight(entry('/flowguard-inline'), null)).toMatchObject({
      guarantee: 'read_only_available',
    });
    expect(catalogPreflight(entry('/choose-workflow'), null)).toMatchObject({
      guarantee: 'eligible_to_attempt',
    });
    for (const invocation of ['/recover-capacity', '/end-governance']) {
      expect(catalogPreflight(entry(invocation), null)).toMatchObject({
        status: 'blocked',
        reasonCode: 'SESSION_REQUIRED',
      });
    }
  });

  it('treats native diagnostics as available without a FlowGuard session', () => {
    expect(catalogPreflight(entry('/diagnostics'), null)).toEqual({
      status: 'available',
      guarantee: 'read_only_available',
    });
    // debug-export writes a diagnostic snapshot file; it is not read-only, even
    // though it never mutates governance.
    expect(catalogPreflight(entry('/debug-export'), null)).toEqual({
      status: 'available',
      guarantee: 'eligible_to_attempt',
    });
  });

  it('fails closed when a catalog entry has no execution metadata', () => {
    const invalid: CommandCatalogEntry = {
      id: 'invalid',
      invocation: '/invalid',
      label: 'Invalid',
      description: 'Invalid entry',
      surfaces: ['portable'],
      maturity: 'stable',
      visibility: 'primary',
      presentationGroup: 'information',
      public: true,
      alsoAvailableAs: [],
    };
    expect(() => catalogPreflight(invalid, null)).toThrow(
      /neither installed metadata nor host metadata/,
    );
  });

  it('has a command-reference entry for every public command', () => {
    for (const candidate of COMMAND_CATALOG) {
      if (!candidate.public) continue;
      expect(docs, candidate.id).toContain(candidate.invocation);
    }
  });
});
