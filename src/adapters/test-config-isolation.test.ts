/**
 * @module adapters/test-config-isolation.test
 * @description Regression guard for the suite-global test isolation introduced
 * to stop tests leaking session directories into the real
 * `~/.config/opencode/workspaces/`.
 *
 * `vitest.setup.ts` runs for every test file in every project and must:
 *   1. activate the production fail-closed guard
 *      (`FLOWGUARD_REQUIRE_TEST_CONFIG_DIR=1`), and
 *   2. resolve the workspace registry under the OS temp dir, never the real
 *      developer config home.
 *
 * If this regresses, an unisolated test could silently write to the real home
 * again — so these assertions fail closed.
 */

import * as os from 'node:os';
import * as path from 'node:path';

import { describe, expect, it } from 'vitest';

import { workspacesHome } from './workspace/init.js';

function isUnderOsTemp(dir: string): boolean {
  const tmpRoot = path.resolve(os.tmpdir());
  const resolved = path.resolve(dir);
  if (resolved === tmpRoot) return true;
  const rel = path.relative(tmpRoot, resolved);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

describe('suite-global test-config isolation', () => {
  it('activates the fail-closed workspace guard for every test', () => {
    expect(process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR).toBe('1');
  });

  it('points OPENCODE_CONFIG_DIR at an isolated OS temp directory', () => {
    const dir = process.env.OPENCODE_CONFIG_DIR;
    expect(dir, 'OPENCODE_CONFIG_DIR must be set by vitest.setup.ts').toBeTruthy();
    expect(isUnderOsTemp(dir!)).toBe(true);
  });

  it('resolves the workspace registry under temp, never the real ~/.config/opencode', () => {
    const home = workspacesHome();
    expect(isUnderOsTemp(home)).toBe(true);
    expect(home.startsWith(path.join(os.homedir(), '.config', 'opencode'))).toBe(false);
  });
});
