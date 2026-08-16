import { describe, it, expect } from 'vitest';
import { diffUnusedExports } from '../check-unused-exports.mjs';

describe('diffUnusedExports', () => {
  it('reports only entries missing from the baseline as added', () => {
    const { added, removed } = diffUnusedExports(
      ['a@x.ts:1', 'b@y.ts:2', 'c@z.ts:3'],
      ['b@y.ts:2', 'old@o.ts:9'],
    );
    expect(added).toEqual(['a@x.ts:1', 'c@z.ts:3']);
    expect(removed).toEqual(['old@o.ts:9']);
  });

  it('returns empty diff when current equals the baseline', () => {
    const { added, removed } = diffUnusedExports(['a@x.ts:1'], ['a@x.ts:1']);
    expect(added).toEqual([]);
    expect(removed).toEqual([]);
  });

  it('treats an empty baseline as everything-added', () => {
    const { added, removed } = diffUnusedExports(['a@x.ts:1', 'b@y.ts:2'], []);
    expect(added).toEqual(['a@x.ts:1', 'b@y.ts:2']);
    expect(removed).toEqual([]);
  });

  it('treats an empty current as everything-removed', () => {
    const { added, removed } = diffUnusedExports([], ['a@x.ts:1']);
    expect(added).toEqual([]);
    expect(removed).toEqual(['a@x.ts:1']);
  });

  it('distinguishes same symbol at different files or lines', () => {
    const { added, removed } = diffUnusedExports(['f@a.ts:1'], ['f@b.ts:1', 'f@a.ts:2']);
    expect(added).toEqual(['f@a.ts:1']);
    expect(removed).toEqual(['f@b.ts:1', 'f@a.ts:2']);
  });
});
