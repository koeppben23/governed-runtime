/** @test-policy BAD — failed workspace observation remains explicit. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { snapshotWorkspace } from '../runners/process-runner.js';

describe('workspace observation assurance', () => {
  it('records an observation error instead of treating an unreadable root as an empty snapshot', async () => {
    const missingRoot = join(
      tmpdir(),
      `flowguard-eval-missing-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    const observation = await snapshotWorkspace(missingRoot);

    expect(observation.entries.size).toBe(0);
    expect(observation.contents.size).toBe(0);
    expect(observation.errors.length).toBeGreaterThan(0);
    expect(observation.errors.join('\n')).toMatch(/readdir/i);
  });

  it('records an observation error for a file above the snapshot byte cap', async () => {
    const root = mkdtempSync(join(tmpdir(), 'flowguard-eval-oversize-'));
    try {
      writeFileSync(join(root, 'large.txt'), Buffer.alloc(1_000_001));
      const observation = await snapshotWorkspace(root);

      expect(observation.entries.has('large.txt')).toBe(false);
      expect(observation.contents.has('large.txt')).toBe(false);
      expect(observation.errors.join('\n')).toMatch(/exceeds the 1000000-byte limit/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
