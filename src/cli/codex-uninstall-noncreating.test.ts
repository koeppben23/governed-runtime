import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { uninstall } from './install.js';
import { repoArgs, setupCliTestEnvironment, tmpDir } from './install-test-helpers.test.js';

setupCliTestEnvironment();

describe('Codex uninstall non-creating behavior', () => {
  it('does not create marketplace parent directories when Codex is not installed', async () => {
    const marketplaceRoot = path.join(tmpDir, '.agents');
    expect(existsSync(marketplaceRoot)).toBe(false);

    const result = await uninstall(
      repoArgs({ action: 'uninstall', installPlatform: 'codex', installScope: 'repo' }),
    );

    expect(result.errors).toEqual([]);
    expect(existsSync(marketplaceRoot)).toBe(false);
    expect(result.ops).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: path.join(tmpDir, '.agents', 'plugins', 'marketplace.json'),
          action: 'not_found',
        }),
      ]),
    );
  });
});
