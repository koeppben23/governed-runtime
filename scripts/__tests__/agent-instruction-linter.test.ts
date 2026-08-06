import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  lintAgentInstructions,
  normalizeRepoPath,
  isRootAgentFile,
  formatDiagnostics,
} from '../agent-instruction-linter.mjs';
import {
  classifyInstructionChainBytes,
  applicableAgentChain,
} from '../agent-instruction-linter-paths.mjs';
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

// ── Check 7: Path references ───────────────────────────────────────

describe('Check 7 — path references', () => {
  it('fails when AGENTS.md references a non-existent path', () => {
    const result = lintFixture('path-missing');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'references missing path "src/nonexistent-file.ts"',
      }),
    );
  });

  it('ignores glob patterns', () => {
    const result = lintFixture('path-glob-ignored');
    expect(result.diagnostics).not.toContainEqual(
      expect.objectContaining({ message: expect.stringContaining('src/**/*.ts') }),
    );
  });

  it('ignores paths inside fenced code blocks', () => {
    const result = lintFixture('path-codeblock-ignored');
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toHaveLength(0);
  });

  it('rejects path references that escape the repository root', () => {
    const result = lintFixture('path-traversal');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('escapes repository root'),
      }),
    );
  });
});

// ── Check 8: CLAUDE.md adjacency ───────────────────────────────────

describe('Check 8 — CLAUDE.md adjacency', () => {
  it('fails when CLAUDE.md has no adjacent AGENTS.md', () => {
    const result = lintFixture('claude-no-adjacent');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'missing adjacent AGENTS.md',
      }),
    );
  });
});

// ── Check 9: Canonical Scope ───────────────────────────────────────

describe('Check 9 — canonical Scope section', () => {
  it('fails when nested AGENTS.md lacks canonical Scope', () => {
    const result = lintFixture('scope-missing');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'missing canonical Scope section',
      }),
    );
  });

  it('does not recognize Scope inside a fenced code block', () => {
    const result = lintFixture('scope-in-codeblock');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: 'missing canonical Scope section',
      }),
    );
  });
});

// ── Check 10: Chain budget ─────────────────────────────────────────

describe('classifyInstructionChainBytes', () => {
  it('returns null below 16 KiB', () => {
    expect(classifyInstructionChainBytes(0)).toBeNull();
    expect(classifyInstructionChainBytes(16383)).toBeNull();
  });

  it('returns warn at exactly 16 KiB', () => {
    expect(classifyInstructionChainBytes(16384)).toBe('warn');
  });

  it('returns warn between 16 and 20 KiB', () => {
    expect(classifyInstructionChainBytes(20479)).toBe('warn');
  });

  it('returns error at exactly 20 KiB', () => {
    expect(classifyInstructionChainBytes(20480)).toBe('error');
  });

  it('returns error above 20 KiB', () => {
    expect(classifyInstructionChainBytes(30000)).toBe('error');
  });
});

describe('applicableAgentChain', () => {
  it('returns only existing files in root-to-leaf order', () => {
    const root = join(FIXTURES, 'chain-warn');
    const chain = applicableAgentChain(root, 'src/AGENTS.md');
    expect(chain).toEqual(['AGENTS.md', 'src/AGENTS.md']);
  });
});

describe('Check 10 — chain byte budget', () => {
  it('warns when chain exceeds 16 KiB warning threshold', () => {
    const result = lintFixture('chain-warn');
    expect(result.ok).toBe(true);
    const warnDiag = result.diagnostics.find(
      (d) => d.kind === 'warn' && d.check === 'instruction-chain-budget',
    );
    expect(warnDiag).toBeDefined();
    expect(warnDiag!.details.files).toHaveLength(2);
  });

  it('errors when chain exceeds 20 KiB maximum', () => {
    const result = lintFixture('chain-error');
    expect(result.ok).toBe(false);
    const errDiag = result.diagnostics.find(
      (d) => d.kind === 'error' && d.check === 'instruction-chain-budget',
    );
    expect(errDiag).toBeDefined();
    expect(errDiag!.details.files).toHaveLength(2);
  });

  it('includes all ancestor files in deep chain structure', () => {
    const root = join(FIXTURES, 'deep-chain');
    const chain = applicableAgentChain(root, 'src/config/AGENTS.md');
    expect(chain).toEqual([
      'AGENTS.md',
      'src/AGENTS.md',
      'src/config/AGENTS.md',
    ]);
  });
});

// ── Check 11: Additive Verification ────────────────────────────────

describe('Check 11 — additive verification', () => {
  it('fails when nested AGENTS.md lacks verification section', () => {
    const result = lintFixture('verify-missing');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('Additional Verification'),
      }),
    );
  });

  it('does not recognize Verification text inside a fenced code block', () => {
    const result = lintFixture('verify-in-codeblock');
    expect(result.ok).toBe(false);
    expect(result.diagnostics).toContainEqual(
      expect.objectContaining({
        kind: 'error',
        message: expect.stringContaining('Additional Verification'),
      }),
    );
  });
});

// ── Check 12: Duplicate paragraphs ─────────────────────────────────

describe('Check 12 — duplicate paragraphs (advisory)', () => {
  it('warns on duplicated instruction paragraphs', () => {
    const result = lintFixture('duplicate-paragraphs');
    const warnDiag = result.diagnostics.find(
      (d) => d.kind === 'warn' && d.message.includes('duplicated instruction paragraph'),
    );
    expect(warnDiag).toBeDefined();
    expect(result.ok).toBe(true);
  });

  it('does not warn on allowed canonical duplicates', () => {
    const result = lintFixture('duplicate-allowed');
    const dupDiag = result.diagnostics.find(
      (d) => d.kind === 'warn' && d.message.includes('duplicated'),
    );
    expect(dupDiag).toBeUndefined();
    expect(result.ok).toBe(true);
  });
});
