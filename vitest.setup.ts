/**
 * @module vitest.setup
 * @description Suite-global, fail-closed test isolation for the FlowGuard
 * workspace registry.
 *
 * Root cause (this fix): FlowGuard resolves its workspace home from
 * `OPENCODE_CONFIG_DIR`, falling back to the REAL `~/.config/opencode` when
 * unset. The production guard in `workspacesHome()` only fail-closes when
 * `FLOWGUARD_REQUIRE_TEST_CONFIG_DIR` is set — and that flag was only set by
 * individual test harnesses, not suite-wide. Any test that persisted state
 * without the harness (e.g. via `makeState()` + a real `writeState`/archive)
 * therefore leaked session directories into the developer's real
 * `~/.config/opencode/workspaces/`.
 *
 * This setup runs for EVERY test file in EVERY project and guarantees two
 * things before any test code executes:
 *   1. `FLOWGUARD_REQUIRE_TEST_CONFIG_DIR=1` — activates the production guard,
 *      so any code path that reaches `workspacesHome()` with a non-temp
 *      `OPENCODE_CONFIG_DIR` (or none) fails closed instead of writing to the
 *      real registry.
 *   2. A per-test-file isolated `OPENCODE_CONFIG_DIR` under the OS temp dir,
 *      unless a test already set its own. Tests that manage the env themselves
 *      (e.g. `withTestEnv({ OPENCODE_CONFIG_DIR: undefined })`) still work: they
 *      override locally and restore afterwards.
 *
 * Net effect: it is impossible for the test suite to write into the real
 * `~/.config/opencode`, and a regression is surfaced as an immediate, localized
 * throw rather than a silent leak.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.FLOWGUARD_REQUIRE_TEST_CONFIG_DIR = '1';

if (!process.env.OPENCODE_CONFIG_DIR) {
  process.env.OPENCODE_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'fg-test-config-'));
}
