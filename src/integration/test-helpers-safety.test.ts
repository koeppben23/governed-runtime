/**
 * @module integration/test-helpers-safety.test
 * @description Isolation guard for the shared integration test harness.
 *
 * The guard is not product behavior: it prevents suite-wide writes to the real
 * `~/.config/opencode` registry. Kept separate from the planning tool suite so
 * that suite stays inside the test file-size budget.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertTestConfigDir, createTestWorkspace, withTestEnv } from './test-helpers.js';

describe('assertTestConfigDir (test safety guard)', () => {
  it('HAPPY: passes when OPENCODE_CONFIG_DIR is set to a temp directory', async () => {
    const ws = await createTestWorkspace();
    expect(() => assertTestConfigDir()).not.toThrow();
    await ws.cleanup();
  });

  it('BAD: throws when OPENCODE_CONFIG_DIR is not set', () => {
    const cleanup = withTestEnv({ OPENCODE_CONFIG_DIR: undefined });
    try {
      expect(() => assertTestConfigDir()).toThrow('Unsafe OPENCODE_CONFIG_DIR');
    } finally {
      cleanup();
    }
  });

  it('BAD: throws when OPENCODE_CONFIG_DIR points to non-temp directory', () => {
    const nonTempPath = path.join(os.homedir(), '.config', 'opencode');
    const cleanup = withTestEnv({ OPENCODE_CONFIG_DIR: nonTempPath });
    try {
      expect(() => assertTestConfigDir()).toThrow('Unsafe OPENCODE_CONFIG_DIR');
    } finally {
      cleanup();
    }
  });
});
