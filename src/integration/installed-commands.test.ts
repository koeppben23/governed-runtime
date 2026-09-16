import { describe, expect, it } from 'vitest';
import {
  INSTALLED_COMMANDS,
  INSTALLED_TEMPLATE_FILES,
  visibleAliasesForDefinition,
} from './installed-commands.js';
import { COMMANDS } from '../templates/commands/index.js';
import { TOOL_FLOWGUARD_ARCHIVE, TOOL_FLOWGUARD_HYDRATE } from './tool-names.js';

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

  it('uses one presentation-or-product fallback conclusion in affected templates', () => {
    const affectedTemplates = [
      'task.md',
      'ticket.md',
      'check.md',
      'validate.md',
      'abort.md',
      'archive.md',
      'export.md',
    ];

    for (const templateFile of affectedTemplates) {
      const body = COMMANDS[templateFile]!;
      expect(body, `${templateFile} must defer to rendered presentation`).toContain(
        'If `presentation.markdown` is present, render it verbatim and do not append a separate `Next action:` line.',
      );
      expect(body, `${templateFile} must have a deterministic product fallback`).toContain(
        'Otherwise, render the canonical `directive` as the single fallback conclusion.',
      );
      expect(body, `${templateFile} must not require an unconditional conclusion`).not.toContain(
        'Response ends with `Next action:',
      );
    }
  });

  it('registers /export as a canonical workflow command', () => {
    const exportDefinition = INSTALLED_COMMANDS.find((command) => command.id === 'workflow.export');
    expect(exportDefinition?.invocation).toBe('/export');
    expect(exportDefinition?.target.toolName).toBe('flowguard_export');
    expect(exportDefinition?.visibility).toBe('primary');
  });

  it('pins exact kind assignments for alias and variant identities', () => {
    const kinds = Object.fromEntries(
      INSTALLED_COMMANDS.filter(
        (definition) => definition.id.startsWith('alias.') || definition.id.startsWith('variant.'),
      ).map((definition) => [definition.id, definition.kind]),
    );
    expect(kinds).toEqual({
      'alias.start': 'preferred_name',
      'alias.task': 'preferred_name',
      'alias.check': 'preferred_name',
      'alias.why': 'convenience',
      'variant.approve': 'action_variant',
      'variant.override-approve': 'action_variant',
      'variant.request-changes': 'action_variant',
      'variant.reject': 'action_variant',
    });
  });

  it('pins canonical fixed arguments for action variants and conveniences', () => {
    const fixedArgs = Object.fromEntries(
      INSTALLED_COMMANDS.filter((definition) => definition.target.fixedArgs !== undefined).map(
        (definition) => [definition.id, definition.target.fixedArgs],
      ),
    );
    expect(fixedArgs).toEqual({
      'variant.approve': { verdict: 'approve' },
      'variant.override-approve': { verdict: 'approve_with_governance_override' },
      'variant.request-changes': { verdict: 'changes_requested' },
      'variant.reject': { verdict: 'reject' },
      'alias.why': { whyBlocked: true },
      'operational.finish': { finish: true },
      'operational.help.context': { view: 'context' },
      'operational.help.commands': { view: 'commands', scope: 'available' },
      'operational.help.commands-all': { view: 'commands', scope: 'all' },
    });
  });

  it('/continue and /check are compatibility surfaces, not product next actions', () => {
    for (const id of ['workflow.continue', 'alias.check'] as const) {
      const definition = INSTALLED_COMMANDS.find((command) => command.id === id);
      expect(definition?.visibility, id).toBe('compatibility');
    }
  });

  it('every installed invocation resolves to complete interface metadata', () => {
    for (const definition of INSTALLED_COMMANDS) {
      expect(definition.id, definition.invocation).toBeTruthy();
      expect(definition.invocation).toMatch(/^\//);
      expect(definition.templateFile, definition.invocation).toMatch(/\.md$/);
      expect(definition.kind, definition.invocation).toBeTruthy();
      expect(definition.visibility, definition.invocation).toBeTruthy();
      expect(definition.presentationGroup, definition.invocation).toBeTruthy();
      expect(definition.description, definition.invocation).toBeTruthy();
      expect(definition.target.toolName, definition.invocation).toBeTruthy();
    }
  });

  it('does not treat export and archive as aliases', () => {
    const exportDef = INSTALLED_COMMANDS.find((command) => command.id === 'workflow.export')!;
    const archiveDef = INSTALLED_COMMANDS.find((command) => command.id === 'operational.archive')!;

    const exportAliases = visibleAliasesForDefinition(exportDef);
    expect(exportAliases).toEqual([]);

    const archiveAliases = visibleAliasesForDefinition(archiveDef);
    expect(archiveAliases).toEqual([]);
  });

  it('has exactly one primary invocation for hydration', () => {
    const primaries = INSTALLED_COMMANDS.filter(
      (definition) =>
        definition.target.toolName === TOOL_FLOWGUARD_HYDRATE &&
        definition.visibility === 'primary',
    ).map((definition) => definition.invocation);
    expect(primaries).toEqual(['/start']);
  });

  it('archive remains an operational visible interface', () => {
    const primaries = INSTALLED_COMMANDS.filter(
      (definition) =>
        definition.target.toolName === TOOL_FLOWGUARD_ARCHIVE &&
        definition.visibility === 'primary',
    ).map((definition) => definition.invocation);
    expect(primaries).toEqual([]);
  });

  it('pins the exact primary surface for preferred_name targets', () => {
    const preferredNameTargets = new Set<string>();
    for (const definition of INSTALLED_COMMANDS) {
      if (definition.kind === 'preferred_name') {
        preferredNameTargets.add(definition.target.toolName);
      }
    }
    const primariesByTarget = Object.fromEntries(
      [...preferredNameTargets].map((toolName) => [
        toolName,
        INSTALLED_COMMANDS.filter(
          (definition) =>
            definition.target.toolName === toolName && definition.visibility === 'primary',
        ).map((definition) => definition.invocation),
      ]),
    );
    // No preferred_name target may expose more than one primary invocation.
    // A compatibility-only target (flowguard_run_check) exposes none.
    expect(primariesByTarget).toEqual({
      flowguard_hydrate: ['/start'],
      flowguard_ticket: ['/task'],
      flowguard_run_check: [],
    });
  });
});
