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
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

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

  it('keeps the archive adapter suites off the real repository root (#1047)', () => {
    // Repo-scoped config lives at {worktree}/.opencode/flowguard.json, outside
    // the isolated registry. These suites must bind temporary git worktrees;
    // a real-root or cwd binding could write or delete a developer's config.
    const suites = ['workspace-archive.test.ts', 'workspace-verify.test.ts', 'workspace.test.ts'];
    for (const suite of suites) {
      const source = readFileSync(fileURLToPath(new URL(suite, import.meta.url)), 'utf-8');
      expect(source, `${suite} must not bind the real repository root`).not.toMatch(
        /path\.resolve\('\.'\)/,
      );
      expect(source, `${suite} must not use process.cwd() as a worktree`).not.toMatch(
        /process\.cwd\(\)/,
      );
    }
  });
});
