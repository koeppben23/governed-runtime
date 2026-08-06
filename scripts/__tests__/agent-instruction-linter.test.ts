import { describe, it, expect } from 'vitest';
import {
  lintAgentInstructions,
  normalizeRepoPath,
  isRootAgentFile,
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

  it('fails when root AGENTS.md exceeds 150 lines', () => {
    const result = lintFixture('over-root-line-budget');
    expect(result.ok).toBe(false);
    const budgetDiag = result.diagnostics.find(
      (d) => d.file === 'AGENTS.md' && d.message.includes('lines'),
    );
    expect(budgetDiag).toBeDefined();
    expect(budgetDiag!.kind).toBe('error');
  });

  it('fails when CLAUDE.md contains extra content', () => {
    const result = lintFixture('impure-claude-adapter');
    expect(result.ok).toBe(false);
    const purityDiag = result.diagnostics.find(
      (d) => d.file === 'CLAUDE.md' && d.kind === 'error',
    );
    expect(purityDiag).toBeDefined();
  });

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
});
