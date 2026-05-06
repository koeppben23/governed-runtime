/**
 * @module cli/install-install.test
 * @description Tests for the install() and uninstall() CLI functions.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
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

setupCliTestEnvironment();

// ─── install ──────────────────────────────────────────────────────────────────

describe('cli/install', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('creates all FlowGuard files in repo scope with --core-tarball', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([
        'Restart OpenCode to activate FlowGuard (plugins are loaded once at startup).',
      ]);

      const oc = path.join(tmpDir, '.opencode');
      expect(existsSync(path.join(oc, MANDATES_FILENAME))).toBe(true);
      expect(existsSync(path.join(oc, 'tools', 'flowguard.ts'))).toBe(true);
      expect(existsSync(path.join(oc, 'plugins', 'flowguard-audit.ts'))).toBe(true);
      for (const name of Object.keys(COMMANDS)) {
        expect(existsSync(path.join(oc, 'commands', name))).toBe(true);
      }
      expect(existsSync(path.join(oc, 'package.json'))).toBe(true);
      expect(existsSync(path.join(tmpDir, 'opencode.json'))).toBe(true);
      expect(existsSync(path.join(oc, 'vendor', `flowguard-core-${VERSION}.tgz`))).toBe(true);
      expect(existsSync(path.join(tmpDir, '.opencode', 'flowguard.json'))).toBe(true);
    });

    it('install --policy-mode regulated persists defaultMode to config', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball, policyMode: 'regulated' }));
      expect(result.errors).toEqual([]);

      const { readConfig } = await import('../adapters/persistence.js');
      const config = await readConfig(tmpDir);
      expect(config.policy.defaultMode).toBe('regulated');
    });

    it('install --policy-mode solo persists defaultMode to config', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball, policyMode: 'solo' }));
      expect(result.errors).toEqual([]);

      const { readConfig } = await import('../adapters/persistence.js');
      const config = await readConfig(tmpDir);
      expect(config.policy.defaultMode).toBe('solo');
    });

    it('install --policy-mode team persists defaultMode to config', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball, policyMode: 'team' }));
      expect(result.errors).toEqual([]);

      const { readConfig } = await import('../adapters/persistence.js');
      const config = await readConfig(tmpDir);
      expect(config.policy.defaultMode).toBe('team');
    });

    it('copies tarball to vendor directory', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors).toEqual([]);

      const vendorPath = path.join(tmpDir, '.opencode', 'vendor', `flowguard-core-${VERSION}.tgz`);
      expect(existsSync(vendorPath)).toBe(true);
      const content = await fs.readFile(vendorPath, 'utf-8');
      expect(content).toBe('mock tarball content');
    });

    it('package.json uses @flowguard/opencode-runtime with file:-dependency', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const content = await fs.readFile(path.join(tmpDir, '.opencode', 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.name).toBe('@flowguard/opencode-runtime');
      expect(parsed.private).toBe(true);
      expect(parsed.dependencies['@flowguard/core']).toBe(
        `file:./vendor/flowguard-core-${VERSION}.tgz`,
      );
      expect(parsed.dependencies['zod']).toBeDefined();
    });

    it('flowguard-mandates.md is a valid managed artifact', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, '.opencode', MANDATES_FILENAME), 'utf-8');
      expect(isManagedArtifact(content)).toBe(true);
      expect(extractManagedDigest(content)).toBe(computeMandatesDigest());
    });

    it('tool wrapper content matches template', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts'),
        'utf-8',
      );
      expect(content.trim()).toBe(TOOL_WRAPPER.trim());
    });

    it('plugin wrapper content matches template', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(
        path.join(tmpDir, '.opencode', 'plugins', 'flowguard-audit.ts'),
        'utf-8',
      );
      expect(content.trim()).toBe(PLUGIN_WRAPPER.trim());
    });

    it('package.json contains @flowguard/core and zod but NOT @opencode-ai/plugin', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, '.opencode', 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.dependencies['@flowguard/core']).toBeDefined();
      expect(parsed.dependencies['zod']).toBeDefined();
      expect(parsed.dependencies['@opencode-ai/plugin']).toBeUndefined();
    });

    it('opencode.json includes flowguard-mandates.md instruction (repo scope)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.instructions).toContain(mandatesInstructionEntry('repo'));
    });

    it('AGENTS.md is NOT created by install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      expect(existsSync(path.join(tmpDir, 'AGENTS.md'))).toBe(false);
    });

    it('opencode.json does NOT contain legacy AGENTS.md entry', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.instructions).not.toContain(LEGACY_INSTRUCTION_ENTRY);
    });
  });

  // ─── AUTO-INSTALL (dependency resolution) ──────────────────
  describe('auto-install', () => {
    it('HAPPY: runs package manager install and creates node_modules op', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors).toEqual([]);
      const nodeModulesOp = result.ops.find((op) => op.path.includes('node_modules'));
      expect(nodeModulesOp).toBeDefined();
      expect(nodeModulesOp!.action).toBe('written');
      const corePath = path.join(tmpDir, '.opencode', 'node_modules', '@flowguard', 'core');
      expect(existsSync(corePath)).toBe(true);
    });

    it('HAPPY: emits restart warning on success', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContainEqual(expect.stringContaining('Restart OpenCode'));
    });

    it('BAD: reports error when package manager install fails', async () => {
      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: Record<string, unknown>) => {
        if (typeof cmd === 'string' && cmd.includes('install'))
          throw new Error('ENOMEM: not enough memory');
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Dependency install failed');
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('BAD: reports error when no package manager is available', async () => {
      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string) => {
        if (typeof cmd === 'string' && cmd.includes('--version')) throw new Error('ENOENT');
        throw new Error('unexpected call');
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));
        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Neither bun nor npm found');
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('EDGE: detects bun before npm (prefers bun)', async () => {
      const { execSync: mockExec } = await import('node:child_process');
      const calls: string[] = [];
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: Record<string, unknown>) => {
        if (typeof cmd === 'string' && cmd.includes('install')) calls.push(cmd.split(' ')[0]);
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        await install(repoArgs({ coreTarball: tarball }));
        expect(calls[0]).toBe('bun');
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('install without --core-tarball returns error', async () => {
      const result = await install(repoArgs());
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('--core-tarball is required');
    });

    it('install with non-existent tarball returns error', async () => {
      const result = await install(
        repoArgs({
          coreTarball: '/nonexistent/flowguard-core-${VERSION}.tgz',
        }),
      );
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('not found');
    });

    it('install with invalid tarball filename returns error', async () => {
      const invalidTarball = path.join(tmpDir, 'invalid-name.tgz');
      await fs.writeFile(invalidTarball, 'content');
      const result = await install(repoArgs({ coreTarball: invalidTarball }));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('must match flowguard-core-');
    });

    it('install with version mismatch returns error', async () => {
      const tarball = await createMockTarball('2.0.0');
      const result = await install(repoArgs({ coreTarball: tarball }));
      expect(result.errors.length).toBeGreaterThan(0);
      expect(result.errors[0]).toContain('Version mismatch');
    });

    it('rollback removes newly created FlowGuard files and restores pre-existing opencode.json', async () => {
      // Setup: pre-existing opencode.json with foreign plugin (user-owned)
      const opencodeJsonPath = path.join(tmpDir, 'opencode.json');
      const preExistingOpencode =
        JSON.stringify({ plugins: [{ path: './custom-plugin.ts' }], instructions: [] }, null, 2) +
        '\n';
      mkdirSync(path.dirname(opencodeJsonPath), { recursive: true });
      await fs.writeFile(opencodeJsonPath, preExistingOpencode);

      // Setup: pre-existing package.json with foreign dep
      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      mkdirSync(path.dirname(pkgPath), { recursive: true });
      await fs.writeFile(
        pkgPath,
        JSON.stringify({ dependencies: { lodash: '^4.0.0' }, scripts: { build: 'tsc' } }, null, 2) +
          '\n',
      );

      // Simulate npm install failure
      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('install')) {
          throw new Error('Simulated npm install failure');
        }
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));

        expect(result.errors.length).toBeGreaterThan(0);
        expect(result.errors[0]).toContain('Dependency install failed');

        // FlowGuard-owned files removed
        const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
        expect(existsSync(mandatesPath)).toBe(false);

        // Pre-existing opencode.json restored to original content (no FlowGuard plugin added)
        expect(existsSync(opencodeJsonPath)).toBe(true);
        const restoredOpencode = await fs.readFile(opencodeJsonPath, 'utf-8');
        expect(restoredOpencode).toBe(preExistingOpencode);

        // Pre-existing package.json restored to original content (no @flowguard/core dep added)
        expect(existsSync(pkgPath)).toBe(true);
        const restoredPkg = await fs.readFile(pkgPath, 'utf-8');
        expect(restoredPkg).toContain('lodash');
        expect(restoredPkg).not.toContain('@flowguard/core');
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('restores pre-existing tarball byte-for-byte on rollback', async () => {
      // Create pre-existing vendor tarball with binary-ish bytes
      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');
      mkdirSync(vendorDir, { recursive: true });
      const tarballName = `flowguard-core-${VERSION}.tgz`;
      const vendorTarballPath = path.join(vendorDir, tarballName);
      const originalBytes = Buffer.from([0x1f, 0x8b, 0x08, ...Array(100).fill(0x00)]);
      await fs.writeFile(vendorTarballPath, originalBytes);

      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('install')) {
          throw new Error('Simulated npm install failure');
        }
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));
        expect(result.errors.length).toBeGreaterThan(0);

        // Tarball must be restored byte-for-byte (not corrupted by UTF-8 encoding)
        expect(existsSync(vendorTarballPath)).toBe(true);
        const restoredBytes = await fs.readFile(vendorTarballPath);
        expect(restoredBytes.length).toBe(originalBytes.length);
        expect(Buffer.compare(restoredBytes, originalBytes)).toBe(0);
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('rollback preserves unrelated user-owned files', async () => {
      // Create unrelated user file before install
      const userFilePath = path.join(tmpDir, '.opencode', 'user-config.json');
      mkdirSync(path.dirname(userFilePath), { recursive: true });
      await fs.writeFile(userFilePath, 'user data');

      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('install')) {
          throw new Error('Simulated npm install failure');
        }
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));

        expect(result.errors.length).toBeGreaterThan(0);

        // Unrelated user file untouched
        expect(existsSync(userFilePath)).toBe(true);
        const content = await fs.readFile(userFilePath, 'utf-8');
        expect(content).toBe('user data');
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('failed reinstall over existing install preserves pre-existing managed files', async () => {
      // Phase 1: Successful install
      const tarball = await createMockTarball();
      const firstResult = await install(repoArgs({ coreTarball: tarball }));
      expect(firstResult.errors).toEqual([]);

      // Capture pre-existing managed file content
      const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
      const toolPath = path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts');
      const vendorDir = path.join(tmpDir, '.opencode', 'vendor');

      expect(existsSync(mandatesPath)).toBe(true);
      const preExistingMandates = await fs.readFile(mandatesPath, 'utf-8');
      const preExistingTool = existsSync(toolPath) ? await fs.readFile(toolPath, 'utf-8') : null;

      // Phase 2: Failed reinstall (npm install fails)
      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('install')) {
          throw new Error('Simulated reinstall failure');
        }
        return originalImpl(cmd, opts);
      });

      const tarball2 = await createMockTarball();
      try {
        const result = await install(repoArgs({ coreTarball: tarball2 }));
        expect(result.errors.length).toBeGreaterThan(0);

        // Managed files must still exist with their ORIGINAL content
        expect(existsSync(mandatesPath)).toBe(true);
        const restoredMandates = await fs.readFile(mandatesPath, 'utf-8');
        expect(restoredMandates).toBe(preExistingMandates);

        if (preExistingTool) {
          expect(existsSync(toolPath)).toBe(true);
          const restoredTool = await fs.readFile(toolPath, 'utf-8');
          expect(restoredTool).toBe(preExistingTool);
        }

        // Vendor directory with tarball must still exist
        expect(existsSync(vendorDir)).toBe(true);

        // Rollback operations must include restorations
        const restorations = result.ops.filter((o) => o.reason?.includes('restored'));
        expect(restorations.length).toBeGreaterThan(0);
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('preserves pre-existing node_modules on rollback', async () => {
      // Create pre-existing node_modules before install
      const nmPath = path.join(tmpDir, '.opencode', 'node_modules', 'some-package');
      mkdirSync(nmPath, { recursive: true });
      await fs.writeFile(path.join(nmPath, 'index.js'), 'module.exports = 1;');

      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('install')) {
          throw new Error('Simulated npm install failure');
        }
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));
        expect(result.errors.length).toBeGreaterThan(0);

        // Pre-existing node_modules must survive
        expect(existsSync(nmPath)).toBe(true);
        const content = await fs.readFile(path.join(nmPath, 'index.js'), 'utf-8');
        expect(content).toBe('module.exports = 1;');
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });

    it('removes newly created node_modules on rollback (npm install ran but failed)', async () => {
      // No pre-existing node_modules for this test

      const { execSync: mockExec } = await import('node:child_process');
      const originalImpl = vi.mocked(mockExec).getMockImplementation()!;
      vi.mocked(mockExec).mockImplementation((cmd: string, opts?: unknown) => {
        if (typeof cmd === 'string' && cmd.includes('install')) {
          // Simulate partial npm install that creates something then throws
          const cwd =
            opts && typeof opts === 'object' && 'cwd' in opts
              ? (opts as { cwd: string }).cwd
              : undefined;
          if (cwd) {
            mkdirSync(path.join(cwd, 'node_modules', '.package-lock.json'), { recursive: true });
          }
          throw new Error('Simulated npm install failure mid-way');
        }
        return originalImpl(cmd, opts);
      });

      try {
        const tarball = await createMockTarball();
        const result = await install(repoArgs({ coreTarball: tarball }));
        expect(result.errors.length).toBeGreaterThan(0);

        // Newly created node_modules should be removed
        const nmPath = path.join(tmpDir, '.opencode', 'node_modules');
        expect(existsSync(nmPath)).toBe(false);
      } finally {
        vi.mocked(mockExec).mockImplementation(originalImpl);
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('idempotent: second install skips existing wrappers (no --force)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const result2 = await install(repoArgs({ coreTarball: tarball }));
      const skipped = result2.ops.filter((op) => op.action === 'skipped');
      expect(skipped.length).toBeGreaterThan(0);
    });

    it('flowguard-mandates.md is ALWAYS replaced even without --force', async () => {
      const tarball = await createMockTarball();
      const mandatesPath = path.join(tmpDir, '.opencode', 'flowguard-mandates.md');
      await fs.mkdir(path.dirname(mandatesPath), { recursive: true });
      await fs.writeFile(mandatesPath, 'old content', 'utf-8');
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(mandatesPath, 'utf-8');
      expect(content).toContain('# FlowGuard Agent Rules');
    });

    it('--force overwrites existing tool wrapper', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const toolPath = path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts');
      await fs.writeFile(toolPath, '// modified', 'utf-8');
      const result = await install(repoArgs({ coreTarball: tarball, force: true }));
      const toolOp = result.ops.find(
        (op) => op.path.includes('flowguard.ts') && op.path.includes('tools'),
      );
      expect(toolOp?.action).toBe('written');
      const content = await fs.readFile(toolPath, 'utf-8');
      expect(content.trim()).toBe(TOOL_WRAPPER.trim());
    });

    it('merges into existing package.json without removing other deps', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify({ dependencies: { lodash: '^4.0.0' } }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.dependencies.lodash).toBe('^4.0.0');
      expect(parsed.dependencies['@flowguard/core']).toBeDefined();
    });

    it('merges into existing opencode.json without removing other config', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ model: 'claude-4-opus' }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.model).toBe('claude-4-opus');
      expect(parsed.instructions).toContain(mandatesInstructionEntry('repo'));
    });

    it('adds flowguard-audit to plugin array in opencode.json', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin).toBeDefined();
      expect(parsed.plugin).toContain('flowguard-audit');
    });

    it('preserves existing plugins when adding flowguard-audit', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ plugin: ['existing-plugin'] }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin).toContain('existing-plugin');
      expect(parsed.plugin).toContain('flowguard-audit');
      expect(parsed.plugin[0]).toBe('existing-plugin');
    });

    it('does not duplicate flowguard-audit on re-install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      const count = (parsed.plugin as string[]).filter(
        (p: string) => p === 'flowguard-audit',
      ).length;
      expect(count).toBe(1);
    });

    it('mergeReviewerTaskPermission enforces *.deny + flowguard-reviewer.allow (P35)', () => {
      const parsed: Record<string, unknown> = {
        agent: {
          build: {
            permission: {
              task: {
                'some-other-agent': 'allow',
              },
            },
          },
        },
      };
      mergeReviewerTaskPermission(parsed);
      const task = ((parsed as Record<string, unknown>).agent as Record<string, unknown>)
        .build as Record<string, unknown>;
      const perm = task.permission as Record<string, unknown>;
      const t = perm.task as Record<string, unknown>;
      expect(t['*']).toBe('deny');
      expect(t['flowguard-reviewer']).toBe('allow');
      expect(t['some-other-agent']).toBeUndefined();
    });

    it('mergeReviewerTaskPermission preserves existing *.deny if already set', () => {
      const parsed: Record<string, unknown> = {
        agent: {
          build: {
            permission: {
              task: {
                '*': 'deny',
              },
            },
          },
        },
      };
      mergeReviewerTaskPermission(parsed);
      const task = ((parsed as Record<string, unknown>).agent as Record<string, unknown>)
        .build as Record<string, unknown>;
      const perm = task.permission as Record<string, unknown>;
      const t = perm.task as Record<string, unknown>;
      expect(t['*']).toBe('deny');
      expect(t['flowguard-reviewer']).toBe('allow');
    });

    it('mergeReviewerTaskPermission handles empty config', () => {
      const parsed: Record<string, unknown> = {};
      mergeReviewerTaskPermission(parsed);
      const task = ((parsed as Record<string, unknown>).agent as Record<string, unknown>)
        .build as Record<string, unknown>;
      const perm = task.permission as Record<string, unknown>;
      const t = perm.task as Record<string, unknown>;
      expect(t['*']).toBe('deny');
      expect(t['flowguard-reviewer']).toBe('allow');
    });

    it('AGENTS.md in project root is never touched even with --force', async () => {
      const tarball = await createMockTarball();
      const agentsPath = path.join(tmpDir, 'AGENTS.md');
      await fs.writeFile(agentsPath, '# My Custom Rules\n', 'utf-8');
      await install(repoArgs({ coreTarball: tarball, force: true }));
      const content = await fs.readFile(agentsPath, 'utf-8');
      expect(content).toBe('# My Custom Rules\n');
    });

    it('supports relative tarball path', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: `./flowguard-core-${VERSION}.tgz` }));
      expect(result.errors).toEqual([]);
      expect(
        existsSync(path.join(tmpDir, '.opencode', 'vendor', `flowguard-core-${VERSION}.tgz`)),
      ).toBe(true);
    });

    it('handles malformed package.json by overwriting', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        '{ this is not valid json }}}',
        'utf-8',
      );
      const result = await install(repoArgs({ coreTarball: tarball }));
      const pkgOp = result.ops.find((op) => op.path.includes('package.json'));
      expect(pkgOp?.action).toBe('written');
      expect(pkgOp?.reason).toContain('malformed');
    });

    it('handles malformed opencode.json by overwriting', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(path.join(tmpDir, 'opencode.json'), 'not json at all{{{', 'utf-8');
      const result = await install(repoArgs({ coreTarball: tarball }));
      const ocOp = result.ops.find((op) => op.path.includes('opencode.json'));
      expect(ocOp?.action).toBe('written');
      expect(ocOp?.reason).toContain('malformed');
    });

    it('legacy migration: removes AGENTS.md from opencode.json instructions', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ instructions: ['AGENTS.md', 'other-instructions.md'] }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.instructions).not.toContain('AGENTS.md');
      expect(parsed.instructions).toContain('other-instructions.md');
      expect(parsed.instructions).toContain(mandatesInstructionEntry('repo'));
    });

    it('removes legacy @opencode-ai/plugin from existing package.json', async () => {
      const tarball = await createMockTarball();
      const pkgDir = path.join(tmpDir, '.opencode');
      await fs.mkdir(pkgDir, { recursive: true });
      await fs.writeFile(
        path.join(pkgDir, 'package.json'),
        JSON.stringify(
          { dependencies: { '@opencode-ai/plugin': '^1.0.0', lodash: '^4.0.0' } },
          null,
          2,
        ),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(pkgDir, 'package.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.dependencies['@opencode-ai/plugin']).toBeUndefined();
      expect(parsed.dependencies.lodash).toBe('^4.0.0');
      expect(parsed.dependencies['@flowguard/core']).toBeDefined();
    });

    it('re-install without --force preserves existing config defaultMode', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball, policyMode: 'regulated' }));
      await install(repoArgs({ coreTarball: tarball, policyMode: 'solo' }));
      const { readConfig } = await import('../adapters/persistence.js');
      const config = await readConfig(tmpDir);
      expect(config.policy.defaultMode).toBe('regulated');
    });

    it('re-install with --force updates config defaultMode', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball, policyMode: 'solo' }));
      await install(repoArgs({ coreTarball: tarball, policyMode: 'regulated', force: true }));
      const { readConfig } = await import('../adapters/persistence.js');
      const config = await readConfig(tmpDir);
      expect(config.policy.defaultMode).toBe('regulated');
    });

    it('re-install with --force preserves non-policy config fields', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball, policyMode: 'solo' }));
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence.js');
      const config = await readConfig(tmpDir);
      config.logging.level = 'debug';
      await writeRepoConfig(tmpDir, config);
      await install(repoArgs({ coreTarball: tarball, policyMode: 'regulated', force: true }));
      const updated = await readConfig(tmpDir);
      expect(updated.policy.defaultMode).toBe('regulated');
      expect(updated.logging.level).toBe('debug');
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('opencode.json does not duplicate instruction entry on re-install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      const entry = mandatesInstructionEntry('repo');
      const count = (parsed.instructions as string[]).filter((i: string) => i === entry).length;
      expect(count).toBe(1);
    });

    it('result ops include every written/merged file', async () => {
      const tarball = await createMockTarball();
      const result = await install(repoArgs({ coreTarball: tarball }));
      const commandCount = Object.keys(COMMANDS).length;
      const expectedOps = 1 + 1 + 1 + 1 + commandCount + 1 + 1 + 1 + 1 + 1;
      expect(result.ops.length).toBe(expectedOps);
    });

    it('user entries in opencode.json instructions are preserved in order', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ instructions: ['first.md', 'second.md', 'third.md'] }, null, 2),
        'utf-8',
      );
      await install(repoArgs({ coreTarball: tarball }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      const instructions = parsed.instructions as string[];
      const firstIdx = instructions.indexOf('first.md');
      const secondIdx = instructions.indexOf('second.md');
      const thirdIdx = instructions.indexOf('third.md');
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
      expect(instructions).toContain(mandatesInstructionEntry('repo'));
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('full install completes in < 500ms', async () => {
      const tarball = await createMockTarball();
      const { elapsedMs } = await measureAsync(async () => {
        await install(repoArgs({ coreTarball: tarball }));
      });
      expect(elapsedMs).toBeLessThan(500);
    });
  });
});

// ─── uninstall ────────────────────────────────────────────────────────────────

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
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('uninstall on empty dir returns not_found ops, no errors', async () => {
      const result = await uninstall(repoArgs({ action: 'uninstall' }));
      expect(result.errors).toEqual([]);
      const notFound = result.ops.filter((op) => op.action === 'not_found');
      expect(notFound.length).toBeGreaterThan(0);
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

    it('uninstall removes flowguard-audit from opencode.json plugins', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin ?? []).not.toContain('flowguard-audit');
    });

    it('uninstall removes flowguard-audit from plugin-only config', async () => {
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify({ plugin: ['flowguard-audit'] }, null, 2),
        'utf-8',
      );
      await uninstall(repoArgs({ action: 'uninstall' }));
      const content = await fs.readFile(path.join(tmpDir, 'opencode.json'), 'utf-8');
      const parsed = JSON.parse(content);
      expect(parsed.plugin ?? []).not.toContain('flowguard-audit');
    });

    it('uninstall preserves other plugins when removing flowguard-audit', async () => {
      const tarball = await createMockTarball();
      await fs.writeFile(
        path.join(tmpDir, 'opencode.json'),
        JSON.stringify(
          { plugin: ['existing-plugin', 'flowguard-audit', 'another-plugin'] },
          null,
          2,
        ),
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

    it('uninstall removes empty plugin array from opencode.json', async () => {
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
});
