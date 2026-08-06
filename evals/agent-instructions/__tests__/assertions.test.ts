import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import {
  evaluateAssertion,
  evaluateAllAssertions,
  type AssertionContext,
  type WorkspaceSnapshot,
} from '../assertions.js';

function emptyCtx(overrides: Partial<AssertionContext> = {}): AssertionContext {
  return {
    stdout: '',
    stderr: '',
    exitCode: 0,
    beforeSnapshot: new Map(),
    afterSnapshot: new Map(),
    beforeContent: new Map(),
    afterContent: new Map(),
    ...overrides,
  };
}

function snapSync(files: Record<string, string>): {
  entries: WorkspaceSnapshot;
  contents: Map<string, string>;
} {
  const entries: WorkspaceSnapshot = new Map();
  const contents = new Map<string, string>();
  for (const [p, c] of Object.entries(files)) {
    const sha = createHash('sha256').update(c).digest('hex');
    entries.set(p, { sha256: sha, bytes: c.length });
    contents.set(p, c);
  }
  return { entries, contents };
}

describe('evaluateAssertion — output', () => {
  it('output_contains passes when value is in stdout', () => {
    const ctx = emptyCtx({ stdout: 'hello world' });
    const r = evaluateAssertion(
      { type: 'output_contains', value: 'world', stream: 'stdout', severity: 'hard', description: 'find world' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('output_contains fails when value is absent', () => {
    const ctx = emptyCtx({ stdout: 'hello' });
    const r = evaluateAssertion(
      { type: 'output_contains', value: 'world', stream: 'stdout', severity: 'hard', description: 'find world' },
      ctx,
    );
    expect(r.passed).toBe(false);
  });

  it('output_contains on combined includes stderr', () => {
    const ctx = emptyCtx({ stdout: 'a', stderr: 'b' });
    const r = evaluateAssertion(
      { type: 'output_contains', value: 'b', stream: 'combined', severity: 'hard', description: 'find b' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('output_matches uses regex', () => {
    const ctx = emptyCtx({ stdout: 'abc123def' });
    const r = evaluateAssertion(
      { type: 'output_matches', pattern: '\\d+', stream: 'combined', severity: 'hard', description: 'has digits' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('output_not_contains passes when absent', () => {
    const ctx = emptyCtx({ stdout: 'safe' });
    const r = evaluateAssertion(
      { type: 'output_not_contains', value: 'danger', stream: 'combined', severity: 'hard', description: 'no danger' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('exit_code matches exact exit code', () => {
    const ctx = emptyCtx({ exitCode: 1 });
    const r = evaluateAssertion(
      { type: 'exit_code', value: 1, severity: 'hard', description: 'exit 1' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('exit_code fails on mismatch', () => {
    const ctx = emptyCtx({ exitCode: 0 });
    const r = evaluateAssertion(
      { type: 'exit_code', value: 1, severity: 'hard', description: 'exit 1' },
      ctx,
    );
    expect(r.passed).toBe(false);
  });
});

describe('evaluateAssertion — file', () => {
  const s = snapSync({ 'src/a.ts': 'import x', 'src/b.ts': 'changed content' });

  it('file_exists passes when file is in snapshot', () => {
    const ctx = emptyCtx({ afterSnapshot: s.entries });
    const r = evaluateAssertion(
      { type: 'file_exists', path: 'src/a.ts', severity: 'hard', description: 'a.ts exists' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('file_changed detects sha256 difference', () => {
    const before = snapSync({ 'src/b.ts': 'original content' });
    const after = snapSync({ 'src/b.ts': 'changed content' });
    const ctx: AssertionContext = {
      stdout: '', stderr: '', exitCode: 0,
      beforeSnapshot: before.entries,
      afterSnapshot: after.entries,
      beforeContent: before.contents,
      afterContent: after.contents,
    };
    const r = evaluateAssertion(
      { type: 'file_changed', path: 'src/b.ts', severity: 'hard', description: 'b.ts changed' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('file_not_changed passes when sha256 matches', () => {
    const s = snapSync({ 'src/a.ts': 'same' });
    const ctx: AssertionContext = {
      stdout: '', stderr: '', exitCode: 0,
      beforeSnapshot: s.entries,
      afterSnapshot: s.entries,
      beforeContent: s.contents,
      afterContent: s.contents,
    };
    const r = evaluateAssertion(
      { type: 'file_not_changed', path: 'src/a.ts', severity: 'hard', description: 'a.ts unchanged' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });

  it('file_contains checks content', () => {
    const ctx = emptyCtx({ afterSnapshot: s.entries, afterContent: s.contents });
    const r = evaluateAssertion(
      { type: 'file_contains', path: 'src/a.ts', value: 'import', severity: 'hard', description: 'has import' },
      ctx,
    );
    expect(r.passed).toBe(true);
  });
});

describe('evaluateAllAssertions', () => {
  it('evaluates all assertions', () => {
    const ctx = emptyCtx({ stdout: 'OK', exitCode: 0 });
    const results = evaluateAllAssertions(
      [
        { type: 'output_contains', value: 'OK', stream: 'combined', severity: 'hard', description: 'has OK' },
        { type: 'exit_code', value: 0, severity: 'hard', description: 'exit 0' },
        { type: 'output_not_contains', value: 'FAIL', stream: 'combined', severity: 'advisory', description: 'no FAIL' },
      ],
      ctx,
    );
    expect(results).toHaveLength(3);
    expect(results.every((r) => r.passed)).toBe(true);
  });
});
