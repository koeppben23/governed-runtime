import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { validatePrDocumentation } from './check-pr-documentation.mjs';

const SCRIPT = fileURLToPath(new URL('./check-pr-documentation.mjs', import.meta.url));
const CHANGELOG =
  '# Changelog\n\n## [Unreleased]\n\n### Changed\n\n- Original entry.\n\n## [1.0.0]\n\n### Added\n\n- Historical entry.\n';
const UPDATED = CHANGELOG.replace('- Original entry.', '- Original entry.\n- New behavior.');
let root: string | undefined;
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe('mandatory per-PR changelog', () => {
  it.each([
    ['new entry', UPDATED],
    ['revised entry', CHANGELOG.replace('Original entry.', 'Corrected behavior.')],
    ['CRLF', UPDATED.replaceAll('\n', '\r\n')],
  ])('accepts a %s', (_name, head) => {
    expect(validatePrDocumentation(CHANGELOG, head).ok).toBe(true);
  });

  it.each([
    ['unchanged content', CHANGELOG],
    ['historical-only edit', CHANGELOG.replace('Historical entry.', 'Old release correction.')],
    ['preamble-only edit', CHANGELOG.replace('# Changelog', '# Updated Changelog')],
    ['deletion-only edit', CHANGELOG.replace('- Original entry.\n', '')],
    ['empty release cut', CHANGELOG.replace('## [Unreleased]', '## [Unreleased]\n\n## [2.0.0]')],
    ['empty bullet', CHANGELOG.replace('- Original entry.', '- Original entry.\n- ')],
    ['line wrapping', CHANGELOG.replace('Original entry.', 'Original\n  entry.')],
    ['category relocation', CHANGELOG.replace('### Changed', '### Fixed')],
    [
      'duplicated entry',
      CHANGELOG.replace('- Original entry.', '- Original entry.\n- Original entry.'),
    ],
    ['comment-only edit', CHANGELOG.replace('Original entry.', 'Original entry. <!-- note -->')],
    ['missing Unreleased', CHANGELOG.replace('[Unreleased]', '[Next]')],
    ['duplicate Unreleased', UPDATED + '\n## [Unreleased]\n\n### Added\n\n- Fake.\n'],
    ['duplicate category', UPDATED.replace('- New behavior.', '### Changed\n\n- New behavior.')],
    ['unknown category', UPDATED.replace('### Changed', '### Unverified')],
    ['uncategorized entry', UPDATED.replace('### Changed\n', '')],
  ])('rejects %s', (_name, head) => {
    expect(validatePrDocumentation(CHANGELOG, head).ok).toBe(false);
  });

  function repository() {
    const directory = mkdtempSync(join(tmpdir(), 'fg-pr-docs-'));
    root = directory;
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=develop');
    git('config', 'user.name', 'Documentation Test');
    git('config', 'user.email', 'docs@example.invalid');
    git('config', 'commit.gpgsign', 'false');
    const commit = (content: string) => {
      writeFileSync(join(directory, 'CHANGELOG.md'), content);
      git('add', 'CHANGELOG.md');
      git(
        '-c',
        'core.hooksPath=',
        'commit',
        '--quiet',
        '-m',
        `docs: changelog on ${git('branch', '--show-current')}`,
      );
      return git('rev-parse', 'HEAD');
    };
    return { git, commit, directory };
  }

  it('compares PR commits to the merge base, not advanced develop or dirty working files', () => {
    const { git, commit, directory } = repository();
    commit(CHANGELOG);
    git('checkout', '-q', '-b', 'feat/test');
    const head = commit(UPDATED);
    git('checkout', '-q', 'develop');
    const base = commit(UPDATED);
    // Both tips have the same entries; the PR still added one relative to its merge base.
    writeFileSync(join(directory, 'CHANGELOG.md'), 'invalid dirty working tree');
    const result = spawnSync(process.execPath, [SCRIPT, base, head], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('Unreleased entry added or revised');
  });

  it('rejects a historical-only committed change despite an Unreleased edit in the working tree', () => {
    const { commit, directory } = repository();
    const base = commit(CHANGELOG);
    const head = commit(CHANGELOG.replace('Historical entry.', 'Edited history.'));
    writeFileSync(join(directory, 'CHANGELOG.md'), UPDATED);
    const result = spawnSync(process.execPath, [SCRIPT, base, head], {
      cwd: directory,
      encoding: 'utf8',
    });
    expect(result.status).toBe(1);
  });

  it('fails closed on missing arguments, invalid revisions and missing committed changelog', () => {
    const { git, commit, directory } = repository();
    const base = commit(CHANGELOG);
    git('rm', '--quiet', 'CHANGELOG.md');
    git('-c', 'core.hooksPath=', 'commit', '--quiet', '-m', 'test: remove changelog');
    const head = git('rev-parse', 'HEAD');
    for (const args of [[], [base], [base, 'missing-ref'], ['--help', head], [base, head]]) {
      const result = spawnSync(process.execPath, [SCRIPT, ...args], { cwd: directory });
      expect(result.status).toBe(2);
    }
  });
});
