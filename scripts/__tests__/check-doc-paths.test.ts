import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  collectScopeDocuments,
  extractPathReferences,
  findMissingPathReferences,
  normalizeReferencePath,
} from '../check-doc-paths.mjs';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixtureDir = join(repoRoot, 'scripts', '__tests__', 'fixtures', 'doc-paths');

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function fixture(name: string): string {
  return readFileSync(join(fixtureDir, name), 'utf8');
}

function missingFor(name: string) {
  return findMissingPathReferences({
    docs: [{ path: `fixtures/${name}`, content: fixture(name) }],
    repoRoot,
  });
}

describe('check-doc-paths', () => {
  it('collects the governed developer documents', () => {
    const documents = collectScopeDocuments({ repoRoot });
    const paths = documents.map((doc) => doc.path);

    expect(paths).toContain('AGENTS.md');
    expect(paths).toContain('CONTRIBUTING.md');
    expect(paths).toContain('docs/testing-strategy.md');
    expect(paths).toContain('docs/development/architecture-map.md');
    expect(paths).toContain('src/integration/AGENTS.md');
    expect(paths.every((path) => path.endsWith('.md'))).toBe(true);
  });

  it('accepts existing repository paths and range/symbol citations', () => {
    expect(missingFor('valid.md')).toEqual([]);
    expect(missingFor('ranges.md')).toEqual([]);
  });

  it('reports a documented path that no longer exists', () => {
    const missing = missingFor('missing.md');

    expect(missing).toHaveLength(1);
    expect(missing[0]).toMatchObject({
      doc: 'fixtures/missing.md',
      path: 'src/this-file-does-not-exist.ts',
      line: 3,
    });
  });

  it('simulates a rename through an injected existence check', () => {
    const reference = 'See `src/index.ts` for the barrel.';
    const existing = findMissingPathReferences({
      docs: [{ path: 'doc.md', content: reference }],
      repoRoot,
      exists: () => true,
    });
    const renamed = findMissingPathReferences({
      docs: [{ path: 'doc.md', content: reference }],
      repoRoot,
      exists: () => false,
    });

    expect(existing).toEqual([]);
    expect(renamed.map((entry) => entry.path)).toEqual(['src/index.ts']);
  });

  it('ignores globs, placeholders, URLs, and bare identifiers', () => {
    expect(missingFor('glob.md')).toEqual([]);
    expect(extractPathReferences(fixture('glob.md'))).toEqual([]);
  });

  it('ignores paths inside fenced code blocks', () => {
    expect(missingFor('fenced.md')).toEqual([]);
    expect(extractPathReferences(fixture('fenced.md')).map((ref) => ref.path)).toEqual([
      'src/index.ts',
    ]);
  });

  it('rejects traversal references even when an external file would exist', () => {
    const missing = findMissingPathReferences({
      docs: [{ path: 'fixtures/traversal.md', content: fixture('traversal.md') }],
      repoRoot,
      exists: () => true,
    });

    expect(missing.map((entry) => ({ path: entry.path, reason: entry.reason }))).toEqual([
      { path: 'src/../../../../etc/passwd', reason: 'traversal' },
      { path: 'docs/../outside-repo.ts', reason: 'traversal' },
    ]);
  });

  it('collects markdown from nested docs/development subdirectories', () => {
    const root = mkdtempSync(join(tmpdir(), 'check-doc-paths-'));
    temporaryDirectories.push(root);
    mkdirSync(join(root, 'docs', 'development', 'nested'), { recursive: true });
    writeFileSync(join(root, 'AGENTS.md'), '`src/index.ts`\n', 'utf8');
    writeFileSync(join(root, 'CONTRIBUTING.md'), 'No paths here.\n', 'utf8');
    writeFileSync(join(root, 'docs', 'testing-strategy.md'), 'No paths here.\n', 'utf8');
    writeFileSync(
      join(root, 'docs', 'development', 'nested', 'guide.md'),
      'Missing `src/nested-missing.ts`.\n',
      'utf8',
    );

    const documents = collectScopeDocuments({ repoRoot: root });
    const missing = findMissingPathReferences({
      docs: documents,
      repoRoot: root,
      exists: () => false,
    });

    expect(documents.map((doc) => doc.path)).toContain('docs/development/nested/guide.md');
    expect(missing).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          doc: 'docs/development/nested/guide.md',
          path: 'src/nested-missing.ts',
          reason: 'missing',
        }),
      ]),
    );
  });

  it('normalizes range and symbol suffixes to the file path', () => {
    expect(normalizeReferencePath('src/a.ts:12-20')).toBe('src/a.ts');
    expect(normalizeReferencePath('src/a.ts:264-292')).toBe('src/a.ts');
    expect(normalizeReferencePath('src/a.ts:fn()')).toBe('src/a.ts');
    expect(normalizeReferencePath('src/a.ts')).toBe('src/a.ts');
  });

  it('runs as a CLI over the repository and reports a summary', () => {
    const result = spawnSync(process.execPath, [join(repoRoot, 'scripts', 'check-doc-paths.mjs')], {
      cwd: repoRoot,
      encoding: 'utf8',
    });

    expect(result.status).toBe(0);
    expect(result.stdout).toContain('[check-doc-paths]');
    expect(result.stdout).toContain('reference(s) OK');
  });

  it('does not execute the CLI when it is imported', () => {
    const moduleUrl = pathToFileURL(join(repoRoot, 'scripts', 'check-doc-paths.mjs')).href;
    const result = spawnSync(
      process.execPath,
      ['--input-type=module', '-e', `await import(${JSON.stringify(moduleUrl)})`],
      { cwd: repoRoot, encoding: 'utf8' },
    );

    expect(result.status).toBe(0);
    expect(result.stdout).not.toContain('[check-doc-paths]');
  });
});
