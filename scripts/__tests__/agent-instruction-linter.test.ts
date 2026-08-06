import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  lintAgentInstructions,
  normalizeRepoPath,
  isRootAgentFile,
  formatDiagnostics,
} from '../agent-instruction-linter.mjs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function lintFixture(name: string) {
  return lintAgentInstructions({ root: join(FIXTURES, name) });
}

describe('normalizeRepoPath', () => {
  it('returns AGENTS.md unchanged for POSIX root path', () => {
    expect(normalizeRepoPath('AGENTS.md')).toBe('AGENTS.md');
  });

  it('strips ./ prefix', () => {
    expect(normalizeRepoPath('./AGENTS.md')).toBe('AGENTS.md');
  });

  it('strips .\\ prefix (Windows-style)', () => {
    expect(normalizeRepoPath('.\\AGENTS.md')).toBe('AGENTS.md');
  });

  it('normalizes Windows backslash separators', () => {
    expect(normalizeRepoPath('src\\config\\AGENTS.md')).toBe('src/config/AGENTS.md');
  });

  it('preserves POSIX nested paths', () => {
    expect(normalizeRepoPath('src/machine/AGENTS.md')).toBe('src/machine/AGENTS.md');
  });

  it('strips only leading dot-slash, not internal dots', () => {
    expect(normalizeRepoPath('./src/.hidden/AGENTS.md')).toBe('src/.hidden/AGENTS.md');
  });
});

describe('isRootAgentFile', () => {
  it('identifies root AGENTS.md', () => {
    expect(isRootAgentFile('AGENTS.md')).toBe(true);
  });

  it('identifies root with ./ prefix', () => {
    expect(isRootAgentFile('./AGENTS.md')).toBe(true);
  });

  it('identifies root with .\\ prefix', () => {
    expect(isRootAgentFile('.\\AGENTS.md')).toBe(true);
  });

  it('rejects nested AGENTS.md', () => {
    expect(isRootAgentFile('src/config/AGENTS.md')).toBe(false);
  });

  it('rejects nested with Windows separators', () => {
    expect(isRootAgentFile('src\\machine\\AGENTS.md')).toBe(false);
  });

  it('rejects deep nesting', () => {
    expect(isRootAgentFile('a/b/c/AGENTS.md')).toBe(false);
  });
});

describe('lintAgentInstructions', () => {
  it('passes with valid fixture', () => {
    const result = lintFixture('valid');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  // Check 1
  it('fails when AGENTS.md references a missing npm run script', () => {
    const result = lintFixture('missing-npm-script');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'references missing script "npm run nonexistent-script"',
      }),
    );
  });

  // Check 2
  it('fails when root AGENTS.md exceeds 150 lines', () => {
    const result = lintFixture('over-root-line-budget');
    expect(result.ok).toBe(false);
    const budgetDiag = result.diagnostics.find(
      (d) => d.file === 'AGENTS.md' && d.message.includes('lines'),
    );
    expect(budgetDiag).toBeDefined();
    expect(budgetDiag!.kind).toBe('error');
  });

  // Check 3
  it('fails when AGENTS.md contains forbidden model names', () => {
    const result = lintFixture('forbidden-model-name');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        file: 'AGENTS.md',
        kind: 'error',
        message: expect.stringContaining('"Claude"'),
      }),
    );
  });

  // Check 4
  it('fails when AGENTS.md contains @-import syntax', () => {
    const result = lintFixture('agent-at-import');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        file: 'AGENTS.md',
        kind: 'error',
        message: expect.stringContaining('@-import'),
      }),
    );
  });

  // Check 5
  it('fails when CLAUDE.md contains extra content', () => {
    const result = lintFixture('impure-claude-adapter');
    expect(result.ok).toBe(false);
    const purityDiag = result.diagnostics.find(
      (d) => d.file === 'CLAUDE.md' && d.kind === 'error',
    );
    expect(purityDiag).toBeDefined();
  });

  // Check 6
  it('fails when nested AGENTS.md weakens force-push rule', () => {
    const result = lintFixture('nested-git-rule-weakening');
    expect(result.ok).toBe(false);
    const pushDiag = result.diagnostics.find(
      (d) => d.file === 'src/machine/AGENTS.md' && d.message.includes('force-push'),
    );
    expect(pushDiag).toBeDefined();
  });

  it('fails when nested AGENTS.md weakens commit rule', () => {
    const result = lintFixture('nested-git-rule-weakening');
    expect(result.ok).toBe(false);
    const commitDiag = result.diagnostics.find(
      (d) => d.file === 'src/machine/AGENTS.md' && d.message.includes('commit'),
    );
    expect(commitDiag).toBeDefined();
  });

  it('normalizes Windows-style ignored paths', () => {
    const result = lintAgentInstructions({
      root: join(FIXTURES, 'nested-git-rule-weakening'),
      ignoredPaths: ['.\\src\\machine'],
    });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });
});

describe('formatDiagnostics', () => {
  it('returns empty string when no diagnostics', () => {
    expect(formatDiagnostics([])).toBe('');
  });

  it('formats error diagnostic with FAIL prefix', () => {
    const output = formatDiagnostics([
      { kind: 'error', file: 'AGENTS.md', message: 'bad thing' },
    ]);
    expect(output).toContain('FAIL');
    expect(output).toContain('AGENTS.md');
    expect(output).toContain('bad thing');
  });

  it('formats warn diagnostic with WARN prefix', () => {
    const output = formatDiagnostics([
      { kind: 'warn', message: 'advisory' },
    ]);
    expect(output).toContain('WARN');
    expect(output).toContain('advisory');
  });
});

describe('CLI wrapper', () => {
  const cliPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'check-agent-instructions.mjs');

  it('exits 0 for valid fixture directory', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, join(FIXTURES, 'valid')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('All checks passed');
  });

  it('exits 1 for fixture with failures', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, join(FIXTURES, 'impure-claude-adapter')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL');
    expect(result.stderr).toContain('Some checks failed');
  });

  it('writes diagnostics to stderr', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, join(FIXTURES, 'over-root-line-budget')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('FAIL');
  });

  it('accepts optional root argument', () => {
    const result = spawnSync(
      process.execPath,
      [cliPath, join(FIXTURES, 'valid')],
      { encoding: 'utf8' },
    );
    expect(result.status).toBe(0);
  });
});
