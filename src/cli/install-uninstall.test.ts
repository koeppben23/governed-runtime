/**
 * @module cli/install-uninstall.test
 * @description Tests for the uninstall() CLI function.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withTestEnv } from '../integration/test-helpers.js';
import { measureAsync } from '../test-policy.js';
import { resolveCodexMarketplaceRoot } from './codex-plugin-install.js';
import { computeMandatesDigest, install, uninstall } from './install.js';
import {
  VERSION,
  createMockTarball,
  globalArgs,
  repoArgs,
  setupCliTestEnvironment,
  tmpDir,
} from './install-test-helpers.test.js';
import {
  COMMANDS,
  MANDATES_FILENAME,
  PLUGIN_WRAPPER,
  PLUGIN_RELATIVE_PATH,
  extractManagedDigest,
  isManagedArtifact,
  mandatesInstructionEntry,
} from './templates.js';
import { parseJsonc } from './install-json.js';

// ─── Mock: child_process ──────────────────────────────────────────────────────
vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  const mockImpl = (
    cmd: string,
    args?: string[] | { cwd?: string; stdio?: unknown; timeout?: number },
    opts?: { cwd?: string; stdio?: unknown; timeout?: number },
  ) => {
    const isVersion =
      typeof cmd === 'string' &&
      (cmd.includes('--version') || (Array.isArray(args) && args[0] === '--version'));
    if (isVersion) return Buffer.from('1.0.0\n');
    const cwd =
      (typeof opts === 'object' && opts?.cwd) ||
      (typeof args === 'object' && !Array.isArray(args) && args?.cwd);
    if (cwd) {
      const corePath = path.join(cwd, 'node_modules', '@flowguard', 'core');
      mkdirSync(corePath, { recursive: true });
      return Buffer.from('');
    }
    return Buffer.from('');
  };
  return {
    ...original,
    execFileSync: vi.fn(mockImpl),
    execSync: vi.fn(mockImpl),
  };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args)),
    unlink: vi.fn((...args: Parameters<typeof actual.unlink>) => actual.unlink(...args)),
    rmdir: vi.fn((...args: Parameters<typeof actual.rmdir>) => actual.rmdir(...args)),
    lstat: vi.fn((...args: Parameters<typeof actual.lstat>) => actual.lstat(...args)),
    readdir: vi.fn((...args: Parameters<typeof actual.readdir>) => actual.readdir(...args)),
  };
});

setupCliTestEnvironment();

const CODEX_MARKETPLACE_ENTRY_REPO = {
  name: 'flowguard',
  source: { source: 'local', path: './plugins/flowguard' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
};

const CODEX_MARKETPLACE_ENTRY_GLOBAL = {
  name: 'flowguard',
  source: { source: 'local', path: './.codex/plugins/flowguard' },
  policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
  category: 'Productivity',
};

async function findBackupFor(filePath: string): Promise<string | null> {
  const entries = await fs.readdir(path.dirname(filePath));
  const prefix = `${path.basename(filePath)}.flowguard-backup-`;
  const backup = entries.find((entry) => entry.startsWith(prefix));
  return backup ? path.join(path.dirname(filePath), backup) : null;
}

describe('cli/uninstall', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('removes FlowGuard files after install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);

      const oc = path.join(tmpDir, '.opencode');
      expect(existsSync(path.join(oc, MANDATES_FILENAME))).toBe(false);
      expect(existsSync(path.join(oc, 'tools', 'flowguard.ts'))).toBe(false);
      expect(existsSync(path.join(oc, PLUGIN_RELATIVE_PATH))).toBe(false);
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, 'commands', name))).toBe(false);
      }
      expect(existsSync(path.join(oc, 'vendor'))).toBe(false);
    });

    it('removes package.json entirely when FlowGuard-only', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      expect(existsSync(pkgPath)).toBe(true);
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(pkgPath)).toBe(false);
    });

    it('preserves later-added foreign bytes throughout node_modules after removing the package shell', async () => {
      const tarball = await createMockTarball();
      expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
      const target = path.join(process.cwd(), '.opencode');
      const modules = path.join(target, 'node_modules');
      const foreign = [
        'customer-sentinel.bin',
        'customer-package/nested/sentinel.bin',
        '@flowguard/core/customer-sentinel.bin',
        '@flowguard/core/node_modules/foreign/sentinel.bin',
      ];
      const bytes = Buffer.from([0, 255, 13, 10, 128, 42]);
      for (const entry of foreign) {
        const file = path.join(modules, entry);
        await fs.mkdir(path.dirname(file), { recursive: true });
        await fs.writeFile(file, bytes);
      }

      const result = await uninstall(repoArgs({ action: 'uninstall' }));

      expect(result.errors).toEqual([]);
      for (const entry of foreign)
        expect(await fs.readFile(path.join(modules, entry))).toEqual(bytes);
      expect(existsSync(path.join(target, 'package.json'))).toBe(false);
      expect(existsSync(path.join(target, PLUGIN_RELATIVE_PATH))).toBe(false);
      expect(result.ops).toContainEqual({
        path: modules,
        action: 'skipped',
        reason: 'nonempty dependency directory; exclusive content ownership not proven; preserved',
      });
    });

    it.each(['empty', 'absent'] as const)(
      'cleans up an %s dependency directory without recursive deletion',
      async (kind) => {
        const tarball = await createMockTarball();
        expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
        const modules = path.join(process.cwd(), '.opencode', 'node_modules');
        await fs.rm(modules, { recursive: true });
        if (kind === 'empty') await fs.mkdir(modules);

        const result = await uninstall(repoArgs({ action: 'uninstall' }));

        expect(result.errors).toEqual([]);
        expect(existsSync(modules)).toBe(false);
        expect(result.ops).toContainEqual(
          expect.objectContaining({
            path: modules,
            action: kind === 'empty' ? 'removed' : 'not_found',
          }),
        );
      },
    );

    it.each(['symlink', 'file'] as const)(
      'preserves a dependency-root %s without following it',
      async (kind) => {
        const tarball = await createMockTarball();
        expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
        const modules = path.join(process.cwd(), '.opencode', 'node_modules');
        await fs.rm(modules, { recursive: true });
        const foreign = path.join(tmpDir, 'foreign-dependencies');
        await fs.mkdir(foreign);
        await fs.writeFile(path.join(foreign, 'sentinel'), 'foreign bytes');
        if (kind === 'symlink') await fs.symlink(foreign, modules, 'junction');
        else await fs.writeFile(modules, 'not a directory');

        const result = await uninstall(repoArgs({ action: 'uninstall' }));

        expect(result.errors).toEqual([]);
        expect(result.ops).toContainEqual({
          path: modules,
          action: 'skipped',
          reason: 'dependency-tree ownership/type mismatch; preserved',
        });
        expect(await fs.readFile(path.join(foreign, 'sentinel'), 'utf8')).toBe('foreign bytes');
        if (kind === 'symlink') expect((await fs.lstat(modules)).isSymbolicLink()).toBe(true);
        else expect(await fs.readFile(modules, 'utf8')).toBe('not a directory');
      },
    );

    it('preserves a file added just before the atomic empty-directory removal', async () => {
      const tarball = await createMockTarball();
      expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
      const modules = path.join(process.cwd(), '.opencode', 'node_modules');
      await fs.rm(modules, { recursive: true });
      await fs.mkdir(modules);
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.rmdir).mockImplementationOnce(async (directory) => {
        expect(directory).toBe(modules);
        await fs.writeFile(path.join(modules, 'racing-sentinel'), 'concurrent bytes');
        return actual.rmdir(directory);
      });

      const result = await uninstall(repoArgs({ action: 'uninstall' }));

      expect(result.errors).toEqual([]);
      expect(await fs.readFile(path.join(modules, 'racing-sentinel'), 'utf8')).toBe(
        'concurrent bytes',
      );
      expect(result.ops).toContainEqual(
        expect.objectContaining({ path: modules, action: 'skipped' }),
      );
    });

    it.each(['EACCES', 'EIO'] as const)(
      'surfaces unexpected dependency cleanup failure %s',
      async (code) => {
        const tarball = await createMockTarball();
        expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
        const modules = path.join(process.cwd(), '.opencode', 'node_modules');
        vi.mocked(fs.rmdir).mockRejectedValueOnce(
          Object.assign(new Error(`dependency cleanup ${code}`), { code }),
        );

        const result = await uninstall(repoArgs({ action: 'uninstall' }));

        expect(result.errors).toEqual([`dependency cleanup ${code}`]);
        expect(existsSync(modules)).toBe(true);
        expect(result.ops).not.toContainEqual(
          expect.objectContaining({ path: modules, action: 'removed' }),
        );
      },
    );

    it('reports EEXIST as preserved dependency contents, not a cleanup failure', async () => {
      const tarball = await createMockTarball();
      expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
      const modules = path.join(process.cwd(), '.opencode', 'node_modules');
      const sentinel = path.join(modules, 'foreign');
      await fs.writeFile(sentinel, 'preserved');
      vi.mocked(fs.rmdir).mockRejectedValueOnce(
        Object.assign(new Error('not empty'), { code: 'EEXIST' }),
      );
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(result.ops).toContainEqual(
        expect.objectContaining({ path: modules, action: 'skipped' }),
      );
      expect(await fs.readFile(sentinel, 'utf8')).toBe('preserved');
    });

    it.each([
      { name: 'customer-runtime', private: true },
      { name: '@flowguard/opencode-runtime', private: false },
      { name: '@flowguard/opencode-runtime', private: true, scripts: { check: 'customer-check' } },
    ])('preserves a later-modified package shell: %j', async (customer) => {
      const tarball = await createMockTarball();
      expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
      const packagePath = path.join(process.cwd(), '.opencode', 'package.json');
      const installed = JSON.parse(await fs.readFile(packagePath, 'utf8'));
      await fs.writeFile(packagePath, JSON.stringify({ ...installed, ...customer }));
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(JSON.parse(await fs.readFile(packagePath, 'utf8'))).toEqual({
        version: installed.version,
        ...customer,
      });
      expect(existsSync(path.join(result.target, 'node_modules'))).toBe(true);
    });

    it('preserves a pre-existing package shell even when its fields match the generated shell', async () => {
      const target = path.join(process.cwd(), '.opencode');
      await fs.mkdir(target);
      const pkgPath = path.join(target, 'package.json');
      const original = { name: '@flowguard/opencode-runtime', private: true };
      await fs.writeFile(pkgPath, JSON.stringify(original));
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(JSON.parse(await fs.readFile(pkgPath, 'utf8'))).toEqual(original);
    });

    it('preserves a user-updated zod declaration instead of treating its name as ownership', async () => {
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const pkgPath = path.join(process.cwd(), '.opencode', 'package.json');
      const installed = JSON.parse(await fs.readFile(pkgPath, 'utf8'));
      installed.dependencies.zod = '^4.9.9';
      await fs.writeFile(pkgPath, JSON.stringify(installed));
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(JSON.parse(await fs.readFile(pkgPath, 'utf8')).dependencies).toEqual({
        zod: '^4.9.9',
      });
    });

    it('preserves a pre-existing zod declaration even when its value matches the installer default', async () => {
      const target = path.join(process.cwd(), '.opencode');
      await fs.mkdir(target);
      const pkgPath = path.join(target, 'package.json');
      await fs.writeFile(pkgPath, JSON.stringify({ dependencies: { zod: '^4.0.0' } }));
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(JSON.parse(await fs.readFile(pkgPath, 'utf8'))).toEqual({
        dependencies: { zod: '^4.0.0' },
      });
    });

    it('reports already-restored package declarations without rewriting their bytes', async () => {
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const pkgPath = path.join(process.cwd(), '.opencode', 'package.json');
      const customer = JSON.stringify({ name: 'customer' }, null, 2) + '\n';
      await fs.writeFile(pkgPath, customer);
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(result.ops).toContainEqual({
        path: pkgPath,
        action: 'skipped',
        reason: 'owned dependency state already restored',
      });
      expect(await fs.readFile(pkgPath, 'utf8')).toBe(customer);
    });

    it('preserves an empty dependency directory when no package removal is authorized', async () => {
      const target = path.join(process.cwd(), '.opencode');
      const modules = path.join(target, 'node_modules');
      await fs.mkdir(modules, { recursive: true });
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect((await fs.lstat(modules)).isDirectory()).toBe(true);
      expect(result.ops.some((op) => op.path === modules)).toBe(false);
    });

    it.each(['ENOENT', 'EACCES', 'EIO'] as const)(
      'handles vendor-directory read failure %s explicitly',
      async (code) => {
        expect(
          (await install(repoArgs({ coreTarball: await createMockTarball() }))).errors,
        ).toEqual([]);
        const vendor = path.join(process.cwd(), '.opencode', 'vendor');
        const actual = await vi.importActual<typeof fs>('node:fs/promises');
        vi.mocked(fs.readdir).mockImplementationOnce(
          async (...args: Parameters<typeof fs.readdir>) => {
            expect(args[0]).toBe(vendor);
            throw Object.assign(new Error(`vendor read ${code}`), { code });
          },
        );
        const result = await uninstall(repoArgs({ action: 'uninstall' }));
        if (code === 'ENOENT') {
          expect(result.errors).toEqual([]);
          expect(result.ops).toContainEqual({ path: vendor, action: 'not_found' });
        } else expect(result.errors).toEqual([`vendor read ${code}`]);
        expect(await actual.readdir(vendor)).not.toEqual([]);
      },
    );

    it('surfaces native managed-file stat errors instead of treating them as absence', async () => {
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const plugin = path.join(process.cwd(), '.opencode', PLUGIN_RELATIVE_PATH);
      const actual = await vi.importActual<typeof fs>('node:fs/promises');
      vi.mocked(fs.lstat).mockImplementation(async (...args: Parameters<typeof fs.lstat>) => {
        if (args[0] === plugin)
          throw Object.assign(new Error('plugin stat denied'), { code: 'EACCES' });
        return actual.lstat(...args);
      });
      try {
        const result = await uninstall(repoArgs({ action: 'uninstall' }));
        expect(result.errors).toEqual(['plugin stat denied']);
        expect(await fs.readFile(plugin, 'utf8')).toBe(PLUGIN_WRAPPER);
      } finally {
        vi.mocked(fs.lstat).mockImplementation((...args: Parameters<typeof fs.lstat>) =>
          actual.lstat(...args),
        );
      }
    });

    it('warns and preserves a user-modified native entrypoint', async () => {
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const plugin = path.join(process.cwd(), '.opencode', PLUGIN_RELATIVE_PATH);
      const custom = PLUGIN_WRAPPER + '\n// Customer change\n';
      await fs.writeFile(plugin, custom);
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain(
        `${plugin} differs from the FlowGuard-managed template — preserved`,
      );
      expect(await fs.readFile(plugin, 'utf8')).toBe(custom);
    });

    it('warns and preserves a directory substituted for a native managed file', async () => {
      expect((await install(repoArgs({ coreTarball: await createMockTarball() }))).errors).toEqual(
        [],
      );
      const plugin = path.join(process.cwd(), '.opencode', PLUGIN_RELATIVE_PATH);
      await fs.unlink(plugin);
      await fs.mkdir(plugin);
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain(`${plugin} is not a regular managed file — preserved`);
      expect((await fs.lstat(plugin)).isDirectory()).toBe(true);
    });

    it('preserves a nonempty Codex target and reports the retained customer content', async () => {
      const target = path.join(process.cwd(), 'plugins', 'flowguard');
      await fs.mkdir(target, { recursive: true });
      const sentinel = path.join(target, 'foreign');
      await fs.writeFile(sentinel, 'customer bytes');
      const result = await uninstall(repoArgs({ action: 'uninstall', installPlatform: 'codex' }));
      expect(result.errors).toEqual([]);
      expect(result.ops).toContainEqual({
        path: target,
        action: 'skipped',
        reason: 'Codex target contains preserved or non-FlowGuard content',
      });
      expect(await fs.readFile(sentinel, 'utf8')).toBe('customer bytes');
    });

    it('does not create an OpenCode config on install or uninstall', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
    });

    // Claude Code assurance is intentionally deferred while OpenCode is the product merge scope.
    it('removes Claude Code plugin tree without touching foreign .claude content', async () => {
      const tarball = await createMockTarball();
      await install(
        repoArgs({ coreTarball: tarball, installPlatform: 'claude-code', force: true }),
      );
      const foreignPath = path.join(tmpDir, '.claude', 'user-settings.json');
      await fs.writeFile(foreignPath, '{"theme":"dark"}\n', 'utf-8');

      const result = await uninstall(
        repoArgs({ action: 'uninstall', installPlatform: 'claude-code' }),
      );

      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(tmpDir, '.claude', 'flowguard-plugin'))).toBe(false);
      expect(await fs.readFile(foreignPath, 'utf-8')).toBe('{"theme":"dark"}\n');
    });

    // Codex assurance is intentionally deferred while OpenCode is the product merge scope.
    it('removes Codex plugin tree and only the FlowGuard marketplace entry', async () => {
      await fs.mkdir(path.join(tmpDir, '.agents', 'plugins'), { recursive: true });
      await fs.writeFile(
        path.join(tmpDir, '.agents', 'plugins', 'marketplace.json'),
        JSON.stringify(
          {
            name: 'local-dev',
            plugins: [
              {
                name: 'foreign',
                source: { source: 'local', path: './foreign' },
                policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
                category: 'Productivity',
              },
            ],
          },
          null,
          2,
        ) + '\n',
      );
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball, installPlatform: 'codex', force: true }));

      const result = await uninstall(repoArgs({ action: 'uninstall', installPlatform: 'codex' }));

      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(tmpDir, 'plugins', 'flowguard'))).toBe(false);
      const marketplace = JSON.parse(
        await fs.readFile(path.join(tmpDir, '.agents', 'plugins', 'marketplace.json'), 'utf-8'),
      );
      expect(marketplace.name).toBe('local-dev');
      expect(marketplace.plugins).toEqual([
        {
          name: 'foreign',
          source: { source: 'local', path: './foreign' },
          policy: { installation: 'AVAILABLE', authentication: 'ON_INSTALL' },
          category: 'Productivity',
        },
      ]);
    });

    it('HAPPY: install/uninstall preserves customer instruction entries', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(jsoncPath, '{ "instructions": ["user.md"] }', 'utf-8');

      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));

      const parsed = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(parsed.instructions).toEqual(['user.md']);
    });

    it('HAPPY: uninstall from JSONC with line+block comments round-trips cleanly', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(
        jsoncPath,
        `{
  // Project model
  "model": "anthropic/claude-sonnet-4-5",
  /* User instructions */
  "instructions": ["user.md"]
}`,
        'utf-8',
      );

      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));

      const content = await fs.readFile(jsoncPath, 'utf-8');
      const parsed = parseJsonc(content);
      expect(parsed.model).toBe('anthropic/claude-sonnet-4-5');
      expect(parsed.instructions).toEqual(['user.md']);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('uninstall on empty dir returns not_found ops, no errors', async () => {
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      const notFound = result.ops.filter((op) => op.action === 'not_found');
      expect(notFound.length).toBeGreaterThan(0);
    });

    it('HAPPY: opencode.jsonc with trailing commas is parsed and merged (valid JSONC)', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(jsoncPath, '{ "model": "anthropic/claude", }', 'utf-8');

      const result = await install(repoArgs({ coreTarball: tarball }));

      expect(result.errors).toEqual([]);
      expect(await findBackupFor(jsoncPath)).toBeNull();
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
      const parsed = parseJsonc(await fs.readFile(jsoncPath, 'utf-8'));
      expect(parsed.model).toBe('anthropic/claude');
      expect(parsed.instructions).toBeUndefined();
    });

    it('uninstall reports error when file cannot be removed (EPERM)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const realImpl = vi.mocked(fs.unlink).getMockImplementation()!;
      vi.mocked(fs.unlink).mockImplementation((...args: Parameters<typeof fs.unlink>) => {
        const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
        if (p.replace(/\\/g, '/').includes(PLUGIN_RELATIVE_PATH)) {
          return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
        }
        return realImpl(...args);
      });

      try {
        const result = await uninstall(repoArgs({ action: 'uninstall' }));
        expect(result.errors.length).toBeGreaterThan(0);
        expect(
          result.errors.some((e) => e.includes('EPERM') || e.includes('operation not permitted')),
        ).toBe(true);
        const toolOps = result.ops.filter((o) =>
          o.path.replace(/\\/g, '/').includes(PLUGIN_RELATIVE_PATH),
        );
        const removedOrNotFound = toolOps.filter(
          (o) => o.action === 'removed' || o.action === 'not_found',
        );
        expect(removedOrNotFound).toHaveLength(0);
      } finally {
        vi.mocked(fs.unlink).mockImplementation(realImpl);
      }
    });

    it.each(['write', 'unlink'] as const)(
      'surfaces package %s failures and preserves recovery provenance',
      async (operation) => {
        const tarball = await createMockTarball();
        const target = path.join(tmpDir, '.opencode');
        await fs.mkdir(target, { recursive: true });
        const packagePath = path.join(target, 'package.json');
        if (operation === 'write')
          await fs.writeFile(packagePath, '{"dependencies":{"customer":"1.0.0"}}');
        expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
        const original = await fs.readFile(packagePath, 'utf8');
        const manifestPath = path.join(target, '.flowguard-install-ownership.json');
        const provenance = await fs.readFile(manifestPath, 'utf8');
        const writeImplementation = vi.mocked(fs.writeFile).getMockImplementation()!;
        const unlinkImplementation = vi.mocked(fs.unlink).getMockImplementation()!;
        const implementation = operation === 'write' ? writeImplementation : unlinkImplementation;
        const failPackageOperation = (...args: unknown[]) => {
          if (path.basename(String(args[0])) === 'package.json') {
            return Promise.reject(
              Object.assign(new Error('EACCES package recovery failed'), { code: 'EACCES' }),
            );
          }
          return Reflect.apply(implementation, undefined, args);
        };
        if (operation === 'write') vi.mocked(fs.writeFile).mockImplementation(failPackageOperation);
        else vi.mocked(fs.unlink).mockImplementation(failPackageOperation);
        try {
          const result = await uninstall(repoArgs({ action: 'uninstall' }));
          expect(result.errors).toEqual([
            expect.stringContaining('EACCES package recovery failed'),
          ]);
          expect(result.ops).not.toContainEqual(
            expect.objectContaining({ reason: 'malformed JSON' }),
          );
          expect(await fs.readFile(packagePath, 'utf8')).toBe(original);
          expect(await fs.readFile(manifestPath, 'utf8')).toBe(provenance);
        } finally {
          vi.mocked(fs.writeFile).mockImplementation(writeImplementation);
          vi.mocked(fs.unlink).mockImplementation(unlinkImplementation);
        }
      },
    );

    it('foreign file in vendor survives while FlowGuard tarball is removed', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      const tarballPath = path.join(vendorDir, `flowguard-core-${VERSION}.tgz`);
      const foreignPath = path.join(vendorDir, 'user-file.bin');

      expect(existsSync(tarballPath)).toBe(true);
      await fs.writeFile(foreignPath, 'user content', 'utf-8');

      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      expect(existsSync(tarballPath)).toBe(false);
      expect(existsSync(foreignPath)).toBe(true);
      const content = await fs.readFile(foreignPath, 'utf-8');
      expect(content).toBe('user content');
      expect(existsSync(vendorDir)).toBe(true);
    });

    it('FlowGuard tarball in vendor is removed on uninstall', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      const tarballPath = path.join(vendorDir, `flowguard-core-${VERSION}.tgz`);
      expect(existsSync(tarballPath)).toBe(true);

      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(tarballPath)).toBe(false);
    });

    it('vendor with no FlowGuard tarballs reports skipped, not not_found', async () => {
      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      mkdirSync(vendorDir, { recursive: true });
      await fs.writeFile(path.join(vendorDir, 'other.txt'), 'x', 'utf-8');

      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      const vendorOps = result.ops.filter((o) => o.path.includes('vendor'));
      expect(vendorOps.some((o) => o.action === 'skipped')).toBe(true);
      expect(vendorOps.some((o) => o.action === 'not_found')).toBe(false);
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('uninstall preserves other dependencies in package.json', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.dependencies.lodash).toBe('^4.0.0');
      expect(parsed.dependencies['@flowguard/core']).toBeUndefined();
    });

    it('AGENTS.md in project root is never touched by uninstall', async () => {
      const tarball = await createMockTarball();
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      await fs.writeFile(agentsPath, '# User rules\n', 'utf-8');
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(agentsPath)).toBe(true);
      const content = await fs.readFile(agentsPath, 'utf-8');
      expect(content).toBe('# User rules\n');
    });

    it('warns when flowguard-mandates.md was locally modified', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
      const original = await fs.readFile(mandatesPath, 'utf-8');
      const modified = original.replace(
        'You are a senior software engineering agent.',
        'You are a modified agent.',
      );
      const body = modified.split('\n\n').slice(1).join('\n\n');
      const digest = createHash('sha256').update(body, 'utf-8').digest('hex');
      await fs.writeFile(
        mandatesPath,
        modified.replace(/sha256:[a-f0-9]{64}/, `sha256:${digest}`),
        'utf-8',
      );
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('different canonical mandate revision');
    });

    it('warns when flowguard-mandates.md has no managed header', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
      await fs.writeFile(mandatesPath, '# Just a plain file\n', 'utf-8');
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('no valid managed envelope');
      expect(await fs.readFile(mandatesPath, 'utf8')).toBe('# Just a plain file\n');
      expect(result.ops).toContainEqual(
        expect.objectContaining({
          path: path.join(result.target, MANDATES_FILENAME),
          action: 'skipped',
          reason: 'same-named file is not a cryptographically valid FlowGuard managed artifact',
        }),
      );
    });

    it('CORNER: both adjacent OpenCode config documents are preserved', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      const jsonPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(jsoncPath, '{ "instructions": ["jsonc.md"] }', 'utf-8');
      await fs.writeFile(jsonPath, '{ "instructions": ["json.md"] }', 'utf-8');

      await install(repoArgs({ coreTarball: tarball }));

      const jsonc = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      const json = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
      expect(jsonc.instructions).toEqual(['jsonc.md']);
      expect(json.instructions).toEqual(['json.md']);
    });

    it('uninstall preserves customer-owned dependencies without ownership provenance', async () => {
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(
          {
            dependencies: {
              '@flowguard/core': '^2.0.0',
              '@opencode-ai/plugin': '^1.0.0',
              lodash: '^4.0.0',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.dependencies['@flowguard/core']).toBe('^2.0.0');
      expect(parsed.dependencies['@opencode-ai/plugin']).toBe('^1.0.0');
      expect(parsed.dependencies.lodash).toBe('^4.0.0');
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('double uninstall is safe', async () => {
      await install(repoArgs());
      await uninstall(repoArgs({ action: 'uninstall' }));
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
    });

    it('uninstall handles opencode.json without plugin array', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
    });

    it('uninstall does not touch foreign plugin array', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ plugin: ['some-npm-plugin'] }, null, 2),
        'utf-8',
      );
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin).toEqual(['some-npm-plugin']);
    });

    it('uninstall preserves other plugins in desktop-owned config', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ plugin: ['existing-plugin', 'another-plugin'] }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin).toEqual(['existing-plugin', 'another-plugin']);
    });

    it('uninstall removes flowguard.json config file', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const cfgPath = path.join(tmpDir, '.opencode', 'flowguard.json');
      expect(existsSync(cfgPath)).toBe(true);
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(cfgPath)).toBe(false);
    });

    it('uninstall preserves native permissions exactly', async () => {
      const tarball = await createMockTarball();
      const configPath = path.join(tmpDir, 'opencode.json');
      const original = '{"permissions":[{"action":"subagent","resource":"*","effect":"ask"}]}\n';
      await fs.writeFile(configPath, original);
      await install(repoArgs({ coreTarball: tarball }));
      expect(await fs.readFile(configPath, 'utf8')).toBe(original);
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(await fs.readFile(configPath, 'utf8')).toBe(original);
    });

    it('EDGE: global install preserves opencode.jsonc in OPENCODE_CONFIG_DIR', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(jsoncPath, '{ "instructions": [] }', 'utf-8');

      const result = await install(globalArgs({ coreTarball: tarball }));

      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
      const parsed = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(parsed.instructions).toEqual([]);
    });

    it('uninstall does not create plugin field when none existed', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
    });

    it('uninstall restores customer @flowguard/core when foreign dependencies exist', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(
          { dependencies: { lodash: '^4.0.0', '@flowguard/core': 'file:./vendor/x.tgz' } },
          null,
          2,
        ),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const pkgPath = path.join(pkgDir, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);
      const content = await fs.readFile(pkgPath, 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.dependencies.lodash).toBe('^4.0.0');
      expect(parsed.dependencies['@flowguard/core']).toBe('file:./vendor/x.tgz');
      expect(parsed.dependencies['zod']).toBeUndefined();
    });

    it('uninstall preserves a user-modified @flowguard/core value after install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      const installed = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      installed.dependencies['@flowguard/core'] = '^9.9.9';
      await fs.writeFile(pkgPath, JSON.stringify(installed, null, 2) + '\n', 'utf-8');

      const result = await uninstall(repoArgs({ action: 'uninstall' }));

      expect(result.errors).toEqual([]);
      expect(result.warnings).toContainEqual(
        expect.stringContaining('@flowguard/core changed after FlowGuard installation'),
      );
      const after = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(after.dependencies['@flowguard/core']).toBe('^9.9.9');
    });

    it('uninstall preserves package.json when scripts exist', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ scripts: { test: 'vitest' } }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const pkgPath = path.join(pkgDir, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);
      const parsed = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(parsed.scripts.test).toBe('vitest');
    });

    it('uninstall restores all pre-existing dependencies', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(
          {
            dependencies: {
              zod: '^3.22.0',
              lodash: '^4.17.21',
              '@flowguard/core': 'file:./vendor/x.tgz',
            },
          },
          null,
          2,
        ),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const pkgPath = path.join(pkgDir, 'package.json');
      expect(existsSync(pkgPath)).toBe(true);
      const parsed = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(parsed.dependencies.lodash).toBe('^4.17.21');
      expect(parsed.dependencies.zod).toBe('^3.22.0');
      expect(parsed.dependencies['@flowguard/core']).toBe('file:./vendor/x.tgz');
    });

    it('uninstall preserves customer task permissions, including reviewer-named entries', async () => {
      const tarball = await createMockTarball();
      const ocPath = path.join(tmpDir, 'opencode.json');
      const ocContent = {
        agent: {
          build: {
            permission: {
              task: { '*': 'deny', 'flowguard-reviewer': 'allow', 'custom-reviewer': 'allow' },
            },
          },
        },
      };
      await fs.writeFile(ocPath, JSON.stringify(ocContent, null, 2) + '\n', 'utf-8');
      expect((await install(repoArgs({ coreTarball: tarball }))).errors).toEqual([]);
      await uninstall(repoArgs({ action: 'uninstall' }));
      const afterContent = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      expect(afterContent.agent.build.permission.task['custom-reviewer']).toBe('allow');
      expect(afterContent).toEqual(ocContent);
    });

    it('EDGE: obsolete parallel FlowGuard registration blocks installation without rewriting either config', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      const jsonPath = path.join(tmpDir, 'opencode.json');

      await fs.writeFile(jsoncPath, '{ "instructions": ["user.md"] }', 'utf-8');
      await fs.writeFile(
        jsonPath,
        JSON.stringify({ instructions: [mandatesInstructionEntry('repo'), 'legacy.md'] }, null, 2),
        'utf-8',
      );

      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errorDetails).toContainEqual(
        expect.objectContaining({ code: 'OPENCODE_FRESH_INSTALL_REQUIRED' }),
      );
      await uninstall(repoArgs({ action: 'uninstall' }));

      const jsonc = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(jsonc.instructions).toEqual(['user.md']);

      const json = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
      expect(json.instructions).toContain(mandatesInstructionEntry('repo'));
      expect(json.instructions).toContain('legacy.md');
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('uninstall completes in < 200ms', async () => {
      await install(repoArgs());
      const { elapsedMs } = await measureAsync(async () => {
        await uninstall(repoArgs({ action: 'uninstall' }));
      });
      expect(elapsedMs).toBeLessThan(200);
    });
  });

  describe('SMOKE', () => {
    it('SMOKE: repo install with opencode.jsonc creates a usable FlowGuard OpenCode layout', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(path.join(tmpDir, 'opencode.jsonc'), '{}', 'utf-8');

      const result = await install(repoArgs({ coreTarball: tarball }));

      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts'))).toBe(false);
      expect(existsSync(path.join(tmpDir, '.opencode', PLUGIN_RELATIVE_PATH))).toBe(true);
      expect(existsSync(path.join(tmpDir, 'opencode.jsonc'))).toBe(true);
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
    });
  });

  describe('E2E', () => {
    it('E2E: install and uninstall round trip preserves user OpenCode JSONC config', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(
        jsoncPath,
        '{ "instructions": ["user.md"], "model": "anthropic/claude" }',
        'utf-8',
      );

      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));

      const parsed = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(parsed.model).toBe('anthropic/claude');
      expect(parsed.instructions).toEqual(['user.md']);
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
    });
  });
});
