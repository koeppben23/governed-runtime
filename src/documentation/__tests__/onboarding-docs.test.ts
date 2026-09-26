import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { INSTALLED_COMMANDS } from '../../integration/installed-commands.js';

const ROOT = process.cwd();
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

/** GitHub-style heading slug used by in-repo cross-document anchors. */
function slugifyHeading(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-');
}

function headingSlugs(markdown: string): Set<string> {
  const slugs = new Set<string>();
  for (const match of markdown.matchAll(/^#{1,6}\s+(.+)$/gm)) {
    slugs.add(slugifyHeading(match[1] ?? ''));
  }
  return slugs;
}

function headingSlugList(markdown: string): string[] {
  return Array.from(markdown.matchAll(/^#{1,6}\s+(.+)$/gm)).map((match) =>
    slugifyHeading(match[1] ?? ''),
  );
}

function declaresFunction(relativePath: string, name: string): boolean {
  const source = ts.createSourceFile(
    relativePath,
    read(relativePath),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (
      ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) &&
        node.name?.text === name) ||
      (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === name)
    ) {
      found = true;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

describe('developer onboarding documentation contract', () => {
  it('links both developer walkthroughs from the documentation index', () => {
    const index = read('docs/index.md');

    expect(index).toContain('./development/first-change.md');
    expect(index).toContain('./development/state-changing-operation.md');
    expect(existsSync(join(ROOT, 'docs/development/first-change.md'))).toBe(true);
    expect(existsSync(join(ROOT, 'docs/development/state-changing-operation.md'))).toBe(true);
    expect(index).toContain('./development/index.md');
    expect(existsSync(join(ROOT, 'docs/development/index.md'))).toBe(true);
  });

  it('preserves critical installation, command, and release anchors without duplicates', () => {
    const targets: Array<[string, readonly string[]]> = [
      [
        'docs/installation.md',
        [
          'installation-steps',
          'host-selection-matrix',
          'non-interactive-mode-opencode-run',
          'http-api-mode-opencode-serve',
          'acp-mode-experimental',
          'user-facing-commands-opencode-workflow',
          'internal-tool-bindings-opencode-infrastructure',
          'uninstall',
        ],
      ],
      [
        'docs/commands.md',
        [
          'command-surface',
          'daily-workflow',
          'diagnose',
          'recovery',
          'advanced',
          'workflow-commands-advancedcanonical',
          'operational-tools',
        ],
      ],
      ['docs/release-policy.md', ['release-process', 'protected-main-release-flow']],
    ];

    for (const [path, anchors] of targets) {
      const slugs = headingSlugList(read(path));
      for (const anchor of anchors) {
        expect(
          slugs.filter((slug) => slug === anchor),
          `${path}#${anchor}`,
        ).toHaveLength(1);
      }
    }
  });

  it('links the contributor entry point from CONTRIBUTING.md', () => {
    expect(read('CONTRIBUTING.md')).toContain('docs/development/index.md');
  });

  it('keeps password-protected HTTP API examples authenticated', () => {
    const distribution = read('docs/distribution-model.md');

    expect(distribution).toContain('OPENCODE_SERVER_PASSWORD=secret');
    expect(distribution.match(/curl -u opencode:secret/g)).toHaveLength(2);
  });

  it('documents every installed command whose tool binding is not a direct name mapping', () => {
    const commands = read('docs/commands.md');
    const exceptions = INSTALLED_COMMANDS.filter((definition) => {
      const directToolName = `flowguard_${definition.invocation
        .slice(1)
        .replace(/\s+--.*/, '')
        .replace(/-/g, '_')}`;

      return (
        definition.target.toolName !== directToolName || definition.target.fixedArgs !== undefined
      );
    });

    for (const definition of exceptions) {
      expect(commands, definition.invocation).toContain(`\`${definition.invocation}\``);
      expect(commands, definition.target.toolName).toContain(`\`${definition.target.toolName}\``);
    }
  });

  it('keeps command details canonical and installation focused on the happy path', () => {
    const installation = read('docs/installation.md');

    expect(installation).toContain('[Commands](./commands.md)');
    expect(installation).not.toContain('**Canonical commands (15):**');
    expect(installation).toContain('[Command Surface](./commands.md#command-surface)');
  });

  it('places regular and recovery commands under their intended navigation sections', () => {
    const commands = read('docs/commands.md');
    const daily = commands.slice(
      commands.indexOf('## Daily Workflow\n'),
      commands.indexOf('## Advanced\n'),
    );
    const recovery = commands.slice(
      commands.indexOf('## Recovery\n'),
      commands.indexOf('## Operational Tools\n'),
    );

    expect(daily).toContain('### /export');
    expect(recovery).toContain('### /validate');
    expect(recovery).toContain('### /continue');
  });

  it('documents the automatic-validation happy path without a manual check', () => {
    const diagram = read('docs/architecture/architecture-diagram.md');

    expect(diagram).toContain('/plan` → `/approve` → `/implement`');
    expect(diagram).toContain('/check` is a manual compatibility and recovery command');
    expect(diagram).not.toContain('/approve` → `/check` → `/implement`');
  });

  it('uses the canonical peer-review terminal phase in the quick reference', () => {
    const index = read('docs/index.md');
    const quickReference = index.split('## Quick Reference')[1] ?? '';

    expect(quickReference).toContain('PEER_REVIEW_COMPLETE');
    expect(quickReference).not.toMatch(/(?<![A-Z_])REVIEW_COMPLETE(?![A-Z_])/);
  });

  it('points contributors to the canonical CI and branch-protection sources', () => {
    const contributing = read('CONTRIBUTING.md');
    const ciSection = contributing.split('### CI Status Checks')[1]?.split('\n## ')[0] ?? '';

    expect(ciSection).toContain('.github/BRANCH-PROTECTION.md');
    expect(ciSection).toContain('.github/workflows/ci.yml');
    expect(ciSection).not.toContain('needs: [unit, integration]');
  });

  it('documents the production-file change checklist and links it from the entry points', () => {
    const map = read('docs/development/architecture-map.md');
    const checklistAnchor = 'architecture-map.md#add-move-or-delete-a-production-file';

    expect(map).toContain('Add, move, or delete a production file');
    for (const phase of ['**Add**', '**Move**', '**Delete**']) {
      expect(map, phase).toContain(phase);
    }
    for (const phrase of [
      'placement entry',
      'zone budget',
      'module classification',
      'mutation inventory',
      'admission record',
    ]) {
      expect(map, phrase).toContain(phrase);
    }

    expect(read('docs/development/first-change.md')).toContain(checklistAnchor);
    expect(read('CONTRIBUTING.md')).toContain(checklistAnchor);
    expect(
      headingSlugs(map).has('add-move-or-delete-a-production-file'),
      'architecture-map.md heading anchor does not resolve',
    ).toBe(true);
  });

  it('cites files and functions in the state-changing guide that actually exist', () => {
    const guide = read('docs/development/state-changing-operation.md');
    const citedTargets = [
      '../../src/integration/tools/decision/decision-tool.ts',
      '../../src/integration/tools/simple/export-tool.ts',
      '../../src/rails/export.ts',
      '../../src/integration/services/regulated-completion.ts',
      '../../src/integration/services/regulated-completion-decision.ts',
      '../../src/integration/plugin-regulated-recovery.ts',
      '../../src/integration/services/regulated-completion.test.ts',
      '../../src/integration/plugin-regulated-recovery.test.ts',
      '../../src/integration/tools/helpers-rail-presentation.ts',
      '../../src/integration/tools/helpers.ts',
      '../../src/integration/audit-outbox.ts',
      '../../src/integration/plugin-audit-reconcile.ts',
      '../../src/integration/tools/write-state-with-artifacts.test.ts',
    ];
    const guideDirectory = join(ROOT, 'docs', 'development');

    for (const target of citedTargets) {
      // The exact relative link must exist verbatim (fragments may follow the
      // path) and must resolve from the guide's directory. Basename-only checks
      // would miss a moved `src/rails/export.ts` shadowed by another export.ts.
      expect(guide, target).toContain(`](${target}`);
      expect(existsSync(resolve(guideDirectory, target)), `${target} does not resolve`).toBe(true);
    }

    // Every relative Markdown link in the guide resolves to a real file.
    for (const match of guide.matchAll(/\]\(([^)\s]+)\)/g)) {
      const target = match[1] ?? '';
      if (!target.startsWith('.')) continue;
      const pathPart = target.split('#')[0] ?? '';
      expect(existsSync(resolve(guideDirectory, pathPart)), `${target} does not resolve`).toBe(
        true,
      );
    }

    const declarations: Array<[string, string]> = [
      ['src/integration/tools/helpers-rail-presentation.ts', 'persistAndFormat'],
      ['src/integration/tools/helpers.ts', 'writeStateWithArtifactsAndAuditOperations'],
      ['src/integration/audit-outbox.ts', 'prepareStateWithAuditOperations'],
      ['src/integration/tools/helpers.ts', 'commitPreparedStateWithArtifactsAlreadyLocked'],
    ];
    for (const [path, name] of declarations) {
      expect(guide).toContain(name);
      expect(declaresFunction(path, name), `${name} is not declared in ${path}`).toBe(true);
    }
  });

  it('documents the separate approval, export, regulated completion, and recovery stages', () => {
    const guide = read('docs/development/state-changing-operation.md');

    for (const path of [
      'decision-tool.ts',
      'export-tool.ts',
      'rails/export.ts',
      'regulated-completion.ts',
      'regulated-completion-decision.ts',
      'plugin-regulated-recovery.ts',
      'regulated-completion.test.ts',
      'plugin-regulated-recovery.test.ts',
      'helpers-rail-presentation.ts',
      'helpers.ts',
      'audit-outbox.ts',
      'plugin-audit-reconcile.ts',
      'write-state-with-artifacts.test.ts',
    ]) {
      expect(guide).toContain(path);
    }
    for (const functionName of [
      'persistAndFormat',
      'writeStateWithArtifactsAndAuditOperations',
      'prepareStateWithAuditOperations',
      'commitPreparedStateWithArtifactsAlreadyLocked',
    ]) {
      expect(guide).toContain(functionName);
    }
    expect(guide).toContain('EXPORT_READY');
    expect(guide).toContain('COMPLETE');
    expect(guide).toContain('approval transition and its associated decision receipt');
    expect(guide).toContain(
      'the export transition and then the `session_completed` lifecycle event',
    );
    expect(guide).toContain('postStateDigest` of the latest open operation');
    expect(guide).toContain("each operation's canonical");
    expect(guide).toContain('directory fsync fails **after** the rename');
    expect(guide).not.toContain('refreshes the ProofGraph twice');
  });
});
