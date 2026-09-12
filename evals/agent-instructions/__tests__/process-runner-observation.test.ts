import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';
import { snapshotWorkspace } from '../runners/process-runner.js';

describe('workspace observation assurance', () => {
  it('records an observation error instead of treating an unreadable root as an empty snapshot', () => {
    const missingRoot = join(
      tmpdir(),
      `flowguard-eval-missing-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );

    const observation = snapshotWorkspace(missingRoot);

    expect(observation.entries.size).toBe(0);
    expect(observation.contents.size).toBe(0);
    expect(observation.errors.length).toBeGreaterThan(0);
    expect(observation.errors.join('\n')).toMatch(/readdir/i);
  });
});
