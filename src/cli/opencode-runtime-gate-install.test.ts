/** Installation registers a native plugin, never an instruction-source activation. */
import { describe, it, expect, vi } from 'vitest';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, symlink, readlink, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { install } from './install-command.js';
import { uninstall } from './uninstall-command.js';
import { PLUGIN_RELATIVE_PATH, PLUGIN_WRAPPER } from './templates.js';
import {
  repoArgs,
  globalArgs,
  createMockTarball,
  setupCliTestEnvironment,
  tmpDir,
} from './install-test-helpers.test.js';
vi.mock('node:child_process', async (importOriginal) => {
  const helpers = await import('./install-test-helpers.test.js');
  return helpers.childProcessMockFactory()(importOriginal);
});
setupCliTestEnvironment();
describe('native installation boundary', () => {
  it('surfaces unavailable filesystem ownership rather than treating an uninspectable path as absent', async () => {
    const target = join(tmpDir, '.opencode');
    await mkdir(target, { recursive: true });
    const obstruction = join(target, 'tools');
    await writeFile(obstruction, 'customer bytes');
    const result = await install(repoArgs({ coreTarball: await createMockTarball(), force: true }));
    expect(result.ops).toEqual([]);
    expect(result.errorDetails).toContainEqual(
      expect.objectContaining({ code: 'INSTALL_OWNERSHIP_UNAVAILABLE' }),
    );
    expect(await readFile(obstruction, 'utf8')).toBe('customer bytes');
  });
  it('preserves a directory occupying the native plugin file path', async () => {
    const plugin = join(tmpDir, '.opencode', PLUGIN_RELATIVE_PATH);
    await mkdir(plugin, { recursive: true });
    const result = await install(repoArgs({ coreTarball: await createMockTarball(), force: true }));
    expect(result.ops).toEqual([]);
    expect(result.errorDetails).toContainEqual(
      expect.objectContaining({ code: 'MANAGED_ARTIFACT_CONFLICT' }),
    );
    expect((await lstat(plugin)).isDirectory()).toBe(true);
  });
  it('does not classify a dangling obsolete wrapper as an absent installation', async () => {
    const parent = join(tmpDir, '.opencode', 'plugins');
    await mkdir(parent, { recursive: true });
    const obsolete = join(parent, 'flowguard-audit.ts');
    const destination = join(tmpDir, 'missing-target');
    await symlink(destination, obsolete);
    const result = await install(repoArgs({ coreTarball: await createMockTarball(), force: true }));
    expect(result.ops).toEqual([]);
    expect(result.errorDetails).toContainEqual(
      expect.objectContaining({ code: 'OPENCODE_FRESH_INSTALL_REQUIRED' }),
    );
    expect(await readlink(obsolete)).toBe(destination);
  });
  it('preserves a symlink at the native plugin path rather than claiming ownership', async () => {
    const parent = join(tmpDir, '.opencode', 'plugins', 'flowguard');
    await mkdir(parent, { recursive: true });
    const external = join(tmpDir, 'customer.ts');
    await writeFile(external, PLUGIN_WRAPPER);
    const plugin = join(parent, 'index.ts');
    await symlink(external, plugin);
    const result = await install(repoArgs({ coreTarball: await createMockTarball(), force: true }));
    expect(result.ops).toEqual([]);
    expect(result.errorDetails).toContainEqual(
      expect.objectContaining({ code: 'MANAGED_ARTIFACT_CONFLICT' }),
    );
    expect((await lstat(plugin)).isSymbolicLink()).toBe(true);
    expect(await readFile(external, 'utf8')).toBe(PLUGIN_WRAPPER);
    const removed = await uninstall(repoArgs({ action: 'uninstall' }));
    expect(removed.errors).toEqual([]);
    expect(removed.ops).toContainEqual(
      expect.objectContaining({
        path: join(process.cwd(), '.opencode', PLUGIN_RELATIVE_PATH),
        action: 'skipped',
        reason: 'ownership/type mismatch',
      }),
    );
    expect((await lstat(plugin)).isSymbolicLink()).toBe(true);
  });
  it.each(['repo', 'global'] as const)(
    'preserves native customer configuration and audit bytes across %s install/reinstall/uninstall',
    async (scope) => {
      const args = scope === 'repo' ? repoArgs : globalArgs;
      const root = scope === 'repo' ? join(tmpDir, '.opencode') : tmpDir;
      await mkdir(root, { recursive: true });
      const original =
        '{ // customer-native config\n "instructions":["AGENTS.md","path/with//slashes.md"], "permissions":[{"action":"subagent","resource":"*","effect":"ask"}], "agents":{"build":{"model":"custom/model#unlisted"}}, "plugins":["customer-plugin"], }\n';
      const files = [join(tmpDir, 'opencode.jsonc'), join(root, 'opencode.json')];
      for (const file of files) await writeFile(file, original);
      const evidence = join(root, 'historical-audit.jsonl');
      await writeFile(evidence, 'historical evidence bytes\n');
      const tarball = await createMockTarball();
      expect((await install(args({ coreTarball: tarball }))).errors).toEqual([]);
      expect((await install(args({ coreTarball: tarball, force: true }))).errors).toEqual([]);
      expect(existsSync(join(root, 'workspaces'))).toBe(false);
      expect(existsSync(join(root, 'SESSION_POINTER.json'))).toBe(false);
      expect((await uninstall(args({ action: 'uninstall' }))).errors).toEqual([]);
      for (const file of files) expect(await readFile(file, 'utf8')).toBe(original);
      expect(await readFile(evidence, 'utf8')).toBe('historical evidence bytes\n');
      expect(existsSync(join(root, PLUGIN_RELATIVE_PATH))).toBe(false);
    },
  );
  it.each(['opencode.json', 'opencode.jsonc'])(
    'rejects malformed %s before artifact writes, even with --force',
    async (name) => {
      const file = join(tmpDir, name);
      const raw = '{ broken config';
      await writeFile(file, raw);
      const result = await install(
        repoArgs({ coreTarball: await createMockTarball(), force: true }),
      );
      expect(result.ops).toEqual([]);
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OPENCODE_CONFIG_INVALID' }),
      );
      expect(await readFile(file, 'utf8')).toBe(raw);
      expect(existsSync(join(tmpDir, '.opencode', PLUGIN_RELATIVE_PATH))).toBe(false);
    },
  );
  it.each(['null', '[]', '"not a config object"'])(
    'rejects non-object OpenCode config %s without writes',
    async (raw) => {
      const file = join(tmpDir, 'opencode.json');
      await writeFile(file, raw);
      const result = await install(repoArgs({ coreTarball: await createMockTarball() }));
      expect(result.ops).toEqual([]);
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OPENCODE_CONFIG_INVALID' }),
      );
      expect(await readFile(file, 'utf8')).toBe(raw);
    },
  );
  it('does not mistake customer options or similarly named packages for FlowGuard registration', async () => {
    const file = join(tmpDir, 'opencode.json');
    const raw = JSON.stringify({
      instructions: ['my-flowguard-mandates.md'],
      plugins: [
        { package: 'customer-plugin', options: { description: '@flowguard/core' } },
        '@flowguard/core-helper',
      ],
    });
    await writeFile(file, raw);
    expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
      [],
    );
    expect(await readFile(file, 'utf8')).toBe(raw);
  });
  it.each([
    { instructions: ['.opencode/flowguard-mandates.md'] },
    { instructions: ['flowguard-mandates.md'] },
    { plugin: ['flowguard-audit'] },
    { plugins: ['@flowguard/core/integration/plugin'] },
    { plugins: [{ package: '@flowguard/core@2.0.0' }] },
    { plugin: [['@flowguard/core', {}]] },
    { plugins: ['./.opencode/plugins/flowguard'] },
  ])(
    'rejects obsolete/duplicate FlowGuard registration %j without synthesizing a new one',
    async (config) => {
      const file = join(tmpDir, 'opencode.json');
      const raw = JSON.stringify(config);
      await writeFile(file, raw);
      const result = await install(
        repoArgs({ coreTarball: await createMockTarball(), force: true }),
      );
      expect(result.ops).toEqual([]);
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OPENCODE_FRESH_INSTALL_REQUIRED' }),
      );
      expect(await readFile(file, 'utf8')).toBe(raw);
    },
  );
  it('installs one native definition and explicitly does not claim activation', async () => {
    const result = await install(repoArgs({ coreTarball: await createMockTarball() }));
    expect(result.errors).toEqual([]);
    expect(await readFile(join(tmpDir, '.opencode', PLUGIN_RELATIVE_PATH), 'utf8')).toBe(
      PLUGIN_WRAPPER,
    );
    expect(existsSync(join(tmpDir, 'opencode.json'))).toBe(false);
    expect(result.notices?.some((n) => n.message.includes('does not activate governance'))).toBe(
      true,
    );
  });
  it.each([
    { relative: 'tools/flowguard.ts', force: false },
    { relative: 'tools/flowguard.ts', force: true },
    { relative: 'plugins/flowguard-audit.ts', force: false },
    { relative: 'plugins/flowguard-audit.ts', force: true },
  ])(
    'rejects obsolete FlowGuard discovery $relative before writes, force=$force',
    async ({ relative, force }) => {
      const target = join(tmpDir, '.opencode');
      await mkdir(join(target, 'tools'), { recursive: true });
      await mkdir(join(target, 'plugins'), { recursive: true });
      const old = join(target, relative);
      await writeFile(old, 'obsolete bytes');
      const result = await install(repoArgs({ coreTarball: await createMockTarball(), force }));
      expect(result.ops).toEqual([]);
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OPENCODE_FRESH_INSTALL_REQUIRED' }),
      );
      expect(await readFile(old, 'utf8')).toBe('obsolete bytes');
      expect(existsSync(join(target, PLUGIN_RELATIVE_PATH))).toBe(false);
      const removal = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(removal.ops).toEqual([]);
      expect(removal.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OPENCODE_FRESH_INSTALL_REQUIRED' }),
      );
      expect(await readFile(old, 'utf8')).toBe('obsolete bytes');
    },
  );
});
