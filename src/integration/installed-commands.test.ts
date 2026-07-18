import { describe, expect, it } from 'vitest';
import { COMMAND_ALIASES } from './command-aliases.js';
import { INSTALLED_COMMANDS } from './installed-commands.js';

describe('installed command catalogue', () => {
  it('has unique stable IDs, filenames, and invocation signatures', () => {
    expect(new Set(INSTALLED_COMMANDS.map((command) => command.id)).size).toBe(
      INSTALLED_COMMANDS.length,
    );
    expect(new Set(INSTALLED_COMMANDS.map((command) => command.filename)).size).toBe(
      INSTALLED_COMMANDS.length,
    );
    expect(new Set(INSTALLED_COMMANDS.map((command) => command.invocation)).size).toBe(
      INSTALLED_COMMANDS.length,
    );
  });

  it('derives /export preference from the canonical alias authority', () => {
    const exportDefinition = INSTALLED_COMMANDS.find((command) => command.id === 'alias.export');
    expect(COMMAND_ALIASES.export?.kind).toBe('preferred_name');
    expect(exportDefinition?.invocation).toBe('/export');
    expect(exportDefinition?.target.toolName).toBe('flowguard_archive');
    expect(exportDefinition?.visibility).toBe('primary');
  });
});
