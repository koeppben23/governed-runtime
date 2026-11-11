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

const docs = readFileSync(new URL('../../../docs/commands.md', import.meta.url), 'utf8');

describe('command catalog', () => {
  it('keeps command ids and invocations unique', () => {
    const ids = COMMAND_CATALOG.map((entry) => entry.id);
    const invocations = COMMAND_CATALOG.map((entry) => entry.invocation);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(invocations).size).toBe(invocations.length);
  });

  it('represents every native plugin command and preserves catalogued parity', () => {
    const catalogInvocations = new Set(COMMAND_CATALOG.map((entry) => entry.invocation));
    const installedInvocations = new Set(INSTALLED_COMMANDS.map((entry) => entry.invocation));

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

  it('keeps the TUI chooser out of native and desktop surfaces in this catalog slice', () => {
    // The Desktop GUI is merged, but its command metadata is the follow-up
    // catalog change; this slice must not claim Desktop support.
    const chooser = COMMAND_CATALOG.find((entry) => entry.invocation === '/choose-workflow');
    expect(chooser?.surfaces).toEqual(['tui']);
    expect(COMMAND_CATALOG.some((entry) => entry.surfaces.includes('desktop'))).toBe(false);
  });

  it('derives surfaces from template installation and native registration', () => {
    const byInvocation = new Map(
      COMMAND_CATALOG.map((entry) => [entry.invocation, entry] as const),
    );
    expect(byInvocation.get('/status')?.surfaces).toEqual(['portable']);
    expect(byInvocation.get('/task')?.surfaces).toEqual(['portable']);
    expect(byInvocation.get('/start')?.surfaces).toEqual(['native']);
    expect(byInvocation.get('/approve')?.surfaces).toEqual(['native']);
    expect(byInvocation.get('/diagnostics')?.surfaces).toEqual(['native']);
  });

  it('handles supported, unsupported and unverified capabilities distinctly', () => {
    const diagnostics = COMMAND_CATALOG.find((entry) => entry.invocation === '/diagnostics');
    const chooser = COMMAND_CATALOG.find((entry) => entry.invocation === '/choose-workflow');
    if (!diagnostics || !chooser) throw new Error('catalog fixture missing');

    const nativeSupported: HelpCapabilities = {
      ...DEFAULT_HELP_CAPABILITIES,
      native: 'supported',
    };
    expect(commandAvailability(diagnostics, nativeSupported)).toBe('available');
    expect(commandAvailability(diagnostics, DEFAULT_HELP_CAPABILITIES)).toBe('not_verified');
    expect(
      commandAvailability(diagnostics, {
        ...DEFAULT_HELP_CAPABILITIES,
        native: 'unsupported',
      }),
    ).toBe('host_unavailable');

    expect(
      commandAvailability(chooser, {
        ...DEFAULT_HELP_CAPABILITIES,
        tui: 'supported',
      }),
    ).toBe('available');
    expect(commandAvailability(chooser, DEFAULT_HELP_CAPABILITIES)).toBe('not_verified');
  });

  it('treats native diagnostics as available without a session', () => {
    const diagnostics = COMMAND_CATALOG.find((entry) => entry.invocation === '/diagnostics');
    const debugExport = COMMAND_CATALOG.find((entry) => entry.invocation === '/debug-export');
    if (!diagnostics || !debugExport) throw new TypeError('catalog fixture missing');
    expect(catalogPreflight(diagnostics, null)).toEqual({
      status: 'available',
      guarantee: 'read_only_available',
    });
    // debug-export writes a diagnostic snapshot file; it is not read-only, even
    // though it never mutates governance.
    expect(catalogPreflight(debugExport, null)).toEqual({
      status: 'available',
      guarantee: 'eligible_to_attempt',
    });
    const recover = COMMAND_CATALOG.find((entry) => entry.invocation === '/recover-capacity');
    if (!recover) throw new TypeError('catalog fixture missing: /recover-capacity');
    expect(catalogPreflight(recover, null)).toMatchObject({
      status: 'blocked',
      reasonCode: 'SESSION_REQUIRED',
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
    for (const entry of COMMAND_CATALOG) {
      if (!entry.public) continue;
      expect(docs, entry.id).toContain(entry.invocation);
    }
  });
});
