/** Publication ordering/rollback only; the running-host smoke owns real import proof. */
import { describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import { install } from './install-command.js';
import { PLUGIN_RELATIVE_PATH, PLUGIN_WRAPPER } from './templates.js';
import {
  createMockTarball,
  globalArgs,
  repoArgs,
  setupCliTestEnvironment,
  tmpDir,
} from './install-test-helpers.test.js';

vi.mock('node:child_process', async (importOriginal) => {
  const helpers = await import('./install-test-helpers.test.js');
  return helpers.childProcessMockFactory()(importOriginal);
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  };
});
setupCliTestEnvironment();

describe('native plugin publication', () => {
  it.each(['repo', 'global'] as const)(
    'publishes %s only after dependencies are live',
    async (scope) => {
      const tarball = await createMockTarball();
      const target = scope === 'repo' ? path.join(tmpDir, '.opencode') : tmpDir;
      const plugin = path.join(target, PLUGIN_RELATIVE_PATH);
      const { execFileSync } = await import('node:child_process');
      const original = vi.mocked(execFileSync).getMockImplementation()!;
      let staged = false;
      vi.mocked(execFileSync).mockImplementation((...args) => {
        const options = args[2];
        if (String(options?.cwd).includes('node_modules.install.')) {
          staged = true;
          expect(existsSync(plugin), 'a running host must not discover unresolved code').toBe(
            false,
          );
        }
        return original(...args);
      });
      try {
        const result = await install(
          (scope === 'repo' ? repoArgs : globalArgs)({ coreTarball: tarball }),
        );
        expect(result.errors).toEqual([]);
        expect(staged).toBe(true);
        expect(existsSync(path.join(target, 'node_modules/@flowguard/core'))).toBe(true);
        expect(await fs.readFile(plugin, 'utf8')).toBe(PLUGIN_WRAPPER);
      } finally {
        vi.mocked(execFileSync).mockImplementation(original);
      }
    },
  );

  it.each(['repo', 'global'] as const)(
    'restores %s dependencies and plugin if late publication fails',
    async (scope) => {
      const tarball = await createMockTarball();
      const args = (scope === 'repo' ? repoArgs : globalArgs)({ coreTarball: tarball });
      expect((await install(args)).errors).toEqual([]);
      const target = scope === 'repo' ? path.join(tmpDir, '.opencode') : tmpDir;
      const plugin = path.join(target, PLUGIN_RELATIVE_PATH);
      const sentinel = path.join(target, 'node_modules/@flowguard/core/prior-install.txt');
      await fs.writeFile(sentinel, 'original dependency tree');
      const previous = await fs.readFile(plugin, 'utf8');
      const original = vi.mocked(fs.rename).getMockImplementation()!;
      let failed = false;
      vi.mocked(fs.rename).mockImplementation(async (from, to) => {
        if (!failed && String(to).replaceAll('\\', '/').endsWith(`/${PLUGIN_RELATIVE_PATH}`)) {
          failed = true;
          expect(existsSync(sentinel), 'the new tree must already be live').toBe(false);
          throw Object.assign(new Error('plugin publication denied'), { code: 'EACCES' });
        }
        return original(from, to);
      });
      try {
        const result = await install({ ...args, force: true });
        expect(failed, result.errors.join('\n')).toBe(true);
        expect(result.errors.join('\n')).toContain('plugin publication denied');
        expect(await fs.readFile(plugin, 'utf8')).toBe(previous);
        expect(await fs.readFile(sentinel, 'utf8')).toBe('original dependency tree');
      } finally {
        vi.mocked(fs.rename).mockImplementation(original);
      }
    },
  );
});
