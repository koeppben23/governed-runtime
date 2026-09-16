/**
 * @module cli/opencode-live-host.test
 * @description Unit coverage for the private filesystem boundary of real-host smoke probes.
 *
 * @test-policy HAPPY, CORNER — parallel hosts must not share mutable OpenCode paths.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createIsolatedOpenCodeEnvironment,
  type PinnedOpenCodeHost,
} from './opencode-live-host.js';

const host: PinnedOpenCodeHost = {
  command: 'opencode',
  argsPrefix: [],
  version: '1.2.3',
  env: { OPENCODE_DISABLE_AUTOUPDATE: '1' },
};

describe('createIsolatedOpenCodeEnvironment', () => {
  it('gives parallel host probes disjoint mutable global paths', () => {
    const firstRoot = mkdtempSync(join(tmpdir(), 'fg-opencode-first-'));
    const secondRoot = mkdtempSync(join(tmpdir(), 'fg-opencode-second-'));
    try {
      const first = createIsolatedOpenCodeEnvironment(firstRoot, host);
      const second = createIsolatedOpenCodeEnvironment(secondRoot, host);
      const isolatedKeys = [
        'HOME',
        'USERPROFILE',
        'OPENCODE_TEST_HOME',
        'OPENCODE_CONFIG_DIR',
        'XDG_CONFIG_HOME',
        'XDG_DATA_HOME',
        'XDG_CACHE_HOME',
        'XDG_STATE_HOME',
        'TMPDIR',
        'TMP',
        'TEMP',
      ] as const;

      for (const key of isolatedKeys) expect(first[key]).not.toBe(second[key]);
      expect(first.OPENCODE_TEST_HOME).toBe(firstRoot);
      expect(first.OPENCODE_CONFIG_DIR).toBe(join(firstRoot, '.config', 'opencode'));
      expect(first.XDG_CONFIG_HOME).toBe(join(firstRoot, '.config'));
      expect(first.XDG_DATA_HOME).toBe(join(firstRoot, '.local', 'share'));
      expect(first.XDG_CACHE_HOME).toBe(join(firstRoot, '.cache'));
      expect(first.XDG_STATE_HOME).toBe(join(firstRoot, '.local', 'state'));
      expect(first.TMPDIR).toBe(firstRoot);
      expect(first.TMP).toBe(first.TMPDIR);
      expect(first.TEMP).toBe(first.TMPDIR);
      expect(first.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
      expect(existsSync(first.OPENCODE_CONFIG_DIR!)).toBe(true);
      expect(existsSync(first.TMPDIR!)).toBe(true);
    } finally {
      rmSync(firstRoot, { recursive: true, force: true });
      rmSync(secondRoot, { recursive: true, force: true });
    }
  });
});
