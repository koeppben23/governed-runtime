/**
 * @module cli/install-uninstall.test
 * @description Tests for the uninstall() CLI function.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { install, uninstall, mergeReviewerTaskPermission } from './install.js';
import {
  TOOL_WRAPPER,
  PLUGIN_WRAPPER,
  COMMANDS,
  MANDATES_FILENAME,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
  extractManagedDigest,
  isManagedArtifact,
} from './templates.js';
import { computeMandatesDigest } from './install.js';
import { measureAsync } from '../test-policy.js';
import { withTestEnv } from '../integration/test-helpers.js';
import { resolveCodexMarketplaceRoot } from './codex-plugin-install.js';
import {
  VERSION,
  tmpDir,
  repoArgs,
  globalArgs,
  createMockTarball,
  setupCliTestEnvironment,
} from './install-test-helpers.test.js';

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

      const oc = path.join(tmpDir, '.opencode');
      expect(existsSync(path.join(oc, MANDATES_FILENAME))).toBe(false);
      expect(existsSync(path.join(oc, 'tools', 'flowguard.ts'))).toBe(false);
      expect(existsSync(path.join(oc, 'plugins', 'flowguard-audit.ts'))).toBe(false);
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, 'commands', name))).toBe(false);
      }
      expect(existsSync(path.join(oc, 'vendor'))).toBe(false);
    });

    it('removes package.json entirely when FlowGuard-only', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      expect(existsSync(pkgPath)).toBe(true); // exists after install
      await uninstall(repoArgs({ action: 'uninstall' }));
      expect(existsSync(pkgPath)).toBe(false); // removed after uninstall
    });

    it('removes FlowGuard instruction from opencode.json', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      const entry = mandatesInstructionEntry('repo');
      expect(parsed.instructions).not.toContain(entry);
    });

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

    it('HAPPY: uninstall removes FlowGuard instruction from opencode.jsonc', async () => {
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

      // File must still be valid JSON (comments stripped by write-back)
      const content = await fs.readFile(jsoncPath, 'utf-8');
      const parsed = JSON.parse(content);
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
      // No backup needed - trailing commas are valid JSONC per OpenCode docs
      expect(await findBackupFor(jsoncPath)).toBeNull();
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
      const parsed = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(parsed.model).toBe('anthropic/claude');
      expect(parsed.instructions).toContain(mandatesInstructionEntry('repo'));
    });

    it('uninstall reports error when file cannot be removed (EPERM)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const realImpl = vi.mocked(fs.unlink).getMockImplementation()!;
      vi.mocked(fs.unlink).mockImplementation(((...args: Parameters<typeof fs.unlink>) => {
        const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
        if (p.replace(/\\/g, '/').includes('tools/flowguard.ts'))
          return Promise.reject(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
        return realImpl(...args);
      }) as typeof fs.unlink);

      try {
        const result = await uninstall(repoArgs({ action: 'uninstall' }));
        expect(result.errors.length).toBeGreaterThan(0);
        expect(
          result.errors.some((e) => e.includes('EPERM') || e.includes('operation not permitted')),
        ).toBe(true);

        // The permission-blocked file must NOT be reported as removed or not_found
        const toolOps = result.ops.filter((o) =>
          o.path.replace(/\\/g, '/').includes('tools/flowguard.ts'),
        );
        const removedOrNotFound = toolOps.filter(
          (o) => o.action === 'removed' || o.action === 'not_found',
        );
        expect(removedOrNotFound).toHaveLength(0);
      } finally {
        vi.mocked(fs.unlink).mockImplementation(realImpl);
      }
    });

    it('foreign file in vendor survives while FlowGuard tarball is removed', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      const tarballPath = path.join(vendorDir, `flowguard-core-${VERSION}.tgz`);
      const foreignPath = path.join(vendorDir, 'user-file.bin');

      // Both FlowGuard tarball and foreign file exist
      expect(existsSync(tarballPath)).toBe(true);
      await fs.writeFile(foreignPath, 'user content', 'utf-8');

      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);

      // FlowGuard tarball must be removed
      expect(existsSync(tarballPath)).toBe(false);

      // Foreign file must survive
      expect(existsSync(foreignPath)).toBe(true);
      const content = await fs.readFile(foreignPath, 'utf-8');
      expect(content).toBe('user content');

      // Vendor directory must still exist (foreign file keeps it)
      expect(existsSync(vendorDir)).toBe(true);
    });

    it('FlowGuard tarball in vendor is removed on uninstall', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      const tarballPath = path.join(vendorDir, `flowguard-core-${VERSION}.tgz`);
      expect(existsSync(tarballPath)).toBe(true);

      await uninstall(repoArgs({ action: 'uninstall' }));

      // FlowGuard tarball must be removed
      expect(existsSync(tarballPath)).toBe(false);
    });

    it('vendor with no FlowGuard tarballs reports skipped, not not_found', async () => {
      // Create vendor dir with only foreign content (no tarball)
      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      mkdirSync(vendorDir, { recursive: true });
      await fs.writeFile(path.join(vendorDir, 'other.txt'), 'x', 'utf-8');

      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      const vendorOps = result.ops.filter((o) => o.path.includes('vendor'));
      // Must be 'skipped', not 'not_found' — vendor exists, just has no FlowGuard files
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
      await fs.writeFile(mandatesPath, original + '\n# Extra stuff\n', 'utf-8');
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('modified');
    });

    it('warns when flowguard-mandates.md has no managed header', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
      await fs.writeFile(mandatesPath, '# Just a plain file\n', 'utf-8');
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.warnings.length).toBeGreaterThan(0);
      expect(result.warnings[0]).toContain('no managed header');
    });

    it('CORNER: opencode.jsonc wins when both OpenCode config files exist', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      const jsonPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(jsoncPath, '{ "instructions": ["jsonc.md"] }', 'utf-8');
      await fs.writeFile(jsonPath, '{ "instructions": ["json.md"] }', 'utf-8');

      await install(repoArgs({ coreTarball: tarball }));

      const jsonc = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      const json = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
      expect(jsonc.instructions).toContain(mandatesInstructionEntry('repo'));
      expect(json.instructions).toEqual(['json.md']);
    });

    it('uninstall removes legacy @opencode-ai/plugin from package.json', async () => {
      const tarball = await createMockTarball();
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
      expect(parsed.dependencies['@flowguard/core']).toBeUndefined();
      expect(parsed.dependencies['@opencode-ai/plugin']).toBeUndefined();
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
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      // No plugin array was added during install, so none to remove
      expect(parsed.plugin).toBeUndefined();
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
      // Desktop-owned config — foreign plugins preserved
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

    it('uninstall removes task-hardening from opencode.json', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Verify task-hardening was set by install
      const beforeContent = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const beforeParsed = JSON.parse(beforeContent);
      expect(beforeParsed.agent?.build?.permission?.task?.['*']).toBe('deny');

      await uninstall(repoArgs({ action: 'uninstall' }));
      const afterContent = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const afterParsed = JSON.parse(afterContent);
      expect(afterParsed.agent).toBeUndefined();
    });

    it('EDGE: global install merges opencode.jsonc in OPENCODE_CONFIG_DIR', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(jsoncPath, '{ "instructions": [] }', 'utf-8');

      const result = await install(globalArgs({ coreTarball: tarball }));

      expect(result.errors).toEqual([]);
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(false);
      const parsed = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(parsed.instructions).toContain(mandatesInstructionEntry('global'));
    });

    it('uninstall does not create plugin field when none existed', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin).toBeUndefined();
    });

    it('uninstall preserves package.json when foreign dependencies exist', async () => {
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
      expect(parsed.dependencies['@flowguard/core']).toBeUndefined();
      // zod is preserved when foreign deps exist — user might use it independently
      expect(parsed.dependencies['zod']).toBe('^4.0.0');
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

    it('uninstall preserves zod and all foreign deps when multiple foreign deps exist', async () => {
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
      // All foreign deps preserved — user owns them
      expect(parsed.dependencies['lodash']).toBe('^4.17.21');
      // zod preserved because foreign content exists (user may depend on it independently)
      expect(parsed.dependencies['zod']).toBe('^3.22.0');
      // FlowGuard dep removed
      expect(parsed.dependencies['@flowguard/core']).toBeUndefined();
    });

    it('uninstall preserves foreign task permissions and *:deny when foreign entries exist', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Inject a foreign task permission entry alongside FlowGuard's
      const ocPath = path.join(tmpDir, 'opencode.json');
      const ocContent = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      // Ensure task-hardening was applied by install
      expect(ocContent.agent.build.permission.task['flowguard-reviewer']).toBe('allow');
      expect(ocContent.agent.build.permission.task['*']).toBe('deny');
      // Add a foreign task permission
      ocContent.agent.build.permission.task['custom-reviewer'] = 'allow';
      await fs.writeFile(ocPath, JSON.stringify(ocContent, null, 2) + '\n', 'utf-8');

      await uninstall(repoArgs({ action: 'uninstall' }));
      const afterContent = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      // Foreign task permission preserved
      expect(afterContent.agent.build.permission.task['custom-reviewer']).toBe('allow');
      // *:deny preserved because foreign entries still exist
      expect(afterContent.agent.build.permission.task['*']).toBe('deny');
      // FlowGuard-owned entry removed
      expect(afterContent.agent?.build?.permission?.task?.['flowguard-reviewer']).toBeUndefined();
    });

    it('EDGE: uninstall from opencode.jsonc cleans parallel opencode.json with old FlowGuard entries', async () => {
      const tarball = await createMockTarball();
      const jsoncPath = path.join(tmpDir, 'opencode.jsonc');
      const jsonPath = path.join(tmpDir, 'opencode.json');

      // opencode.jsonc = current user config (no FlowGuard)
      await fs.writeFile(jsoncPath, '{ "instructions": ["user.md"] }', 'utf-8');
      // opencode.json = parallel legacy config with old FlowGuard entry
      await fs.writeFile(
        jsonPath,
        JSON.stringify({ instructions: [mandatesInstructionEntry('repo'), 'legacy.md'] }, null, 2),
        'utf-8',
      );

      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));

      // jsonc: FlowGuard entry must NOT be present (uninstall removed it)
      const jsonc = JSON.parse(await fs.readFile(jsoncPath, 'utf-8'));
      expect(jsonc.instructions).toEqual(['user.md']);

      // json: old FlowGuard entry must be removed, legacy.md preserved
      const json = JSON.parse(await fs.readFile(jsonPath, 'utf-8'));
      expect(json.instructions).not.toContain(mandatesInstructionEntry('repo'));
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
      expect(existsSync(path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts'))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.opencode', 'plugins', 'flowguard-audit.ts'))).toBe(
        true,
      );
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
