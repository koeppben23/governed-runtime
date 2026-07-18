import { describe, expect, it } from 'vitest';
import { COMMAND_ALIASES } from './command-aliases.js';
import {
  INSTALLED_COMMANDS,
  INSTALLED_TEMPLATE_FILES,
  visibleAliasesForDefinition,
} from './installed-commands.js';
import { COMMANDS } from '../templates/commands/index.js';

describe('installed command catalogue', () => {
  it('has unique stable IDs, invocations, and filenames-per-ID', () => {
    expect(new Set(INSTALLED_COMMANDS.map((command) => command.id)).size).toBe(
      INSTALLED_COMMANDS.length,
    );
    expect(new Set(INSTALLED_COMMANDS.map((command) => command.invocation)).size).toBe(
      INSTALLED_COMMANDS.length,
    );
  });

  it('template files and COMMANDS body keys are bidirectionally consistent', () => {
    const bodyFiles = Object.keys(COMMANDS).sort();
    const templateFiles = [...INSTALLED_TEMPLATE_FILES].sort();
    expect(templateFiles).toEqual(bodyFiles);

    for (const templateFile of templateFiles) {
      expect(COMMANDS[templateFile]).toBeDefined();
    }
  });

  it('derives /export preference from the canonical alias authority', () => {
    const exportDefinition = INSTALLED_COMMANDS.find((command) => command.id === 'alias.export');
    expect(COMMAND_ALIASES.export?.kind).toBe('preferred_name');
    expect(exportDefinition?.invocation).toBe('/export');
    expect(exportDefinition?.target.toolName).toBe('flowguard_archive');
    expect(exportDefinition?.visibility).toBe('primary');
  });

  it('visibleAliasesForDefinition resolves from the common target authority', () => {
    const exportDef = INSTALLED_COMMANDS.find((command) => command.id === 'alias.export')!;
    const archiveDef = INSTALLED_COMMANDS.find((command) => command.id === 'operational.archive')!;

    const exportAliases = visibleAliasesForDefinition(exportDef);
    expect(exportAliases).toContain('/archive');

    const archiveAliases = visibleAliasesForDefinition(archiveDef);
    expect(archiveAliases).toContain('/export');
  });
});
