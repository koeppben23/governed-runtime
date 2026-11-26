import { describe, expect, it } from 'vitest';

import {
  MAX_MUTATION_SHARDS,
  mutationTargetOf,
  planMutationShards,
} from '../mutation-shard-plan.mjs';

function weightsFor(targets: readonly string[], weight = 100): Map<string, number> {
  return new Map(targets.map((target) => [target, weight]));
}

describe('mutation shard plan', () => {
  describe('HAPPY', () => {
    it('partitions every selector exactly once and deterministically', () => {
      const selectors = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts', 'src/e.ts', 'src/f.ts'];
      const weights = weightsFor(selectors);
      const first = planMutationShards({ selectors, weights, shardCount: 3 });
      const second = planMutationShards({ selectors, weights, shardCount: 3 });
      expect(second).toEqual(first);
      expect(first.map((shard) => shard.targets.length)).toEqual([2, 2, 2]);
      expect(first.flatMap((shard) => shard.selectors).sort()).toEqual([...selectors].sort());
      const targets = first.flatMap((shard) => shard.targets);
      expect(new Set(targets).size).toBe(selectors.length);
      expect(first.every((shard) => shard.weight === 200)).toBe(true);
    });

    it('balances heavy targets across shards', () => {
      const selectors = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'];
      const weights = new Map([
        ['src/a.ts', 100],
        ['src/b.ts', 80],
        ['src/c.ts', 60],
        ['src/d.ts', 40],
      ]);
      const shards = planMutationShards({ selectors, weights, shardCount: 2 });
      expect(shards.map((shard) => shard.targets)).toEqual([
        ['src/a.ts', 'src/d.ts'],
        ['src/b.ts', 'src/c.ts'],
      ]);
      expect(shards.map((shard) => shard.weight)).toEqual([140, 140]);
    });

    it('keeps a range target in exactly one shard', () => {
      const selectors = ['src/a.ts:1-2', 'src/a.ts:5-6', 'src/b.ts', 'src/c.ts'];
      const shards = planMutationShards({
        selectors,
        weights: new Map([
          ['src/a.ts', 100],
          ['src/b.ts', 100],
          ['src/c.ts', 100],
        ]),
        shardCount: 2,
      });
      const rangeShard = shards.find((shard) => shard.targets.includes('src/a.ts'));
      expect(rangeShard?.selectors.filter((selector) => selector.startsWith('src/a.ts:'))).toEqual([
        'src/a.ts:1-2',
        'src/a.ts:5-6',
      ]);
      expect(
        shards.flatMap((shard) => shard.targets).filter((target) => target === 'src/a.ts'),
      ).toHaveLength(1);
    });
  });

  describe('BAD', () => {
    it('rejects non-positive, non-integer and excessive shard counts', () => {
      const selectors = ['src/a.ts', 'src/b.ts'];
      const weights = weightsFor(selectors);
      expect(() => planMutationShards({ selectors, weights, shardCount: 0 })).toThrow(
        /positive integer/,
      );
      expect(() => planMutationShards({ selectors, weights, shardCount: 1.5 })).toThrow(
        /positive integer/,
      );
      expect(() => planMutationShards({ selectors, weights, shardCount: 3 })).toThrow(
        /exceeds the 2 distinct target/,
      );
      expect(() =>
        planMutationShards({ selectors, weights, shardCount: MAX_MUTATION_SHARDS + 1 }),
      ).toThrow(/supported maximum/);
    });

    it('rejects duplicate selectors, globs and missing weights', () => {
      expect(() =>
        planMutationShards({
          selectors: ['src/a.ts', 'src/a.ts'],
          weights: new Map([['src/a.ts', 1]]),
          shardCount: 1,
        }),
      ).toThrow(/duplicate mutate selector/);
      expect(() =>
        planMutationShards({
          selectors: ['src/**/*.ts'],
          weights: new Map(),
          shardCount: 1,
        }),
      ).toThrow(/is a glob/);
      expect(() =>
        planMutationShards({
          selectors: ['src/a.ts'],
          weights: new Map(),
          shardCount: 1,
        }),
      ).toThrow(/no positive weight/);
    });
  });

  describe('EDGE', () => {
    it('strips mutation ranges from targets and rejects separator characters', () => {
      expect(mutationTargetOf('src/a.ts:10-20')).toBe('src/a.ts');
      expect(mutationTargetOf('src/a.ts')).toBe('src/a.ts');
      expect(() => mutationTargetOf('src/a.ts,src/b.ts')).toThrow(/cannot be sharded/);
      expect(() => mutationTargetOf('')).toThrow(/non-empty/);
    });

    it('preserves canonical selector order inside each shard', () => {
      const selectors = ['src/c.ts', 'src/a.ts', 'src/b.ts'];
      const shards = planMutationShards({
        selectors,
        weights: weightsFor(selectors),
        shardCount: 1,
      });
      expect(shards[0]?.selectors).toEqual(selectors);
      expect(shards[0]?.targets).toEqual(['src/c.ts', 'src/a.ts', 'src/b.ts']);
    });
  });

  describe('CORNER', () => {
    it('uses the lower shard index as the deterministic tie-break', () => {
      const selectors = ['src/a.ts', 'src/b.ts'];
      const shards = planMutationShards({
        selectors,
        weights: weightsFor(selectors),
        shardCount: 2,
      });
      expect(shards[0]?.targets).toEqual(['src/a.ts']);
      expect(shards[1]?.targets).toEqual(['src/b.ts']);
    });
  });
});
