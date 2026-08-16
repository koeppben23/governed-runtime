import { describe, it, expect } from 'vitest';
import { diffUnusedExports } from '../check-unused-exports.mjs';

describe('diffUnusedExports', () => {
  it('reports only entries missing from the baseline as added', () => {
    const { added, removed } = diffUnusedExports(
      ['a@x.ts', 'b@y.ts', 'c@z.ts'],
      ['b@y.ts', 'old@o.ts'],
    );
    expect(added).toEqual(['a@x.ts', 'c@z.ts']);
    expect(removed).toEqual(['old@o.ts']);
  });

  it('returns empty diff when current equals the baseline', () => {
    const { added, removed } = diffUnusedExports(['a@x.ts'], ['a@x.ts']);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('treats an empty baseline as everything-added', () => {
    const { added, removed } = diffUnusedExports(['a@x.ts', 'b@y.ts'], []);
    expect(added).toEqual(['a@x.ts', 'b@y.ts']);
    expect(removed).toEqual([]);
  });

  it('treats an empty current as everything-removed', () => {
    const { added, removed } = diffUnusedExports([], ['a@x.ts']);
    expect(added).toEqual([]);
    expect(removed).toEqual(['a@x.ts']);
  });

  it('treats the same symbol in the same file as unchanged regardless of line', () => {
    // Identities are line-free: a mere code shift must not look like a new export.
    const { added, removed } = diffUnusedExports(['f@a.ts'], ['f@a.ts']);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('treats the same symbol in a different file as a different export', () => {
    const { added, removed } = diffUnusedExports(['f@a.ts'], ['f@b.ts']);
    expect(added).toEqual(['f@a.ts']);
    expect(removed).toEqual(['f@b.ts']);
  });
});
