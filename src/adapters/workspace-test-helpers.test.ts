import { describe, expect, it } from 'vitest';
import { runCleanups } from './workspace-test-helpers.js';

describe('runCleanups', () => {
  it('runs every cleanup in registration order', async () => {
    const calls: string[] = [];
    await runCleanups([
      async () => {
        calls.push('first');
      },
      async () => {
        calls.push('second');
      },
    ]);
    expect(calls).toEqual(['first', 'second']);
  });

  it('continues after a failing cleanup and surfaces the original error alone', async () => {
    const calls: string[] = [];
    const failure = new Error('cleanup failed');
    await expect(
      runCleanups([
        async () => {
          calls.push('first');
          throw failure;
        },
        async () => {
          calls.push('second');
        },
      ]),
    ).rejects.toBe(failure);
    expect(calls).toEqual(['first', 'second']);
  });

  it('aggregates multiple failures after running every cleanup', async () => {
    const calls: string[] = [];
    await expect(
      runCleanups([
        async () => {
          calls.push('first');
          throw new Error('one');
        },
        async () => {
          calls.push('second');
          throw new Error('two');
        },
        async () => {
          calls.push('third');
        },
      ]),
    ).rejects.toBeInstanceOf(AggregateError);
    expect(calls).toEqual(['first', 'second', 'third']);
  });
});
