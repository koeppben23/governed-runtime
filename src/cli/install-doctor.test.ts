/**
 * @module cli/install-doctor.test
 * @description Tests for the doctor() CLI function and its check subroutines.
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { existsSync, mkdirSync } from 'node:fs';
import {
  install,
  uninstall,
  doctor,
  checkPluginActivation,
  checkLastSessionHandshake,
  hasNonFlowGuardInstructions,
  FLOWGUARD_INSTRUCTION_ENTRIES,
} from './install.js';
import {
  COMMANDS,
  MANDATES_FILENAME,
  mandatesInstructionEntry,
  LEGACY_INSTRUCTION_ENTRY,
} from './templates.js';
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

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    unlink: vi.fn((...args: Parameters<typeof actual.unlink>) => actual.unlink(...args)),
  };
});

setupCliTestEnvironment();

// ─── doctor ───────────────────────────────────────────────────────────────────

describe('cli/doctor', () => {
  // ─── HAPPY ─────────────────────────────────────────────────
  describe('HAPPY', () => {
    it('all checks pass after fresh install', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const allOk = checks.every((c) => c.status === 'ok');
      expect(allOk).toBe(true);
    });

    it('returns correct check count', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const expectedChecks = 1 + 1 + 1 + Object.keys(COMMANDS).length + 1 + 1 + 1 + 1 + 1 + 1;
      expect(checks.length).toBe(expectedChecks);
    });
  });

  // ─── BAD ───────────────────────────────────────────────────
  describe('BAD', () => {
    it('reports missing files on empty dir', async () => {
      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const missing = checks.filter((c) => c.status === 'missing');
      expect(missing.length).toBeGreaterThan(0);
    });

    it('reports error not missing when tool wrapper is unreadable (EACCES)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const toolPath = path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
        const p =
          args[0] instanceof Buffer
            ? args[0].toString()
            : typeof args[0] === 'string'
              ? args[0]
              : (args[0] as URL).pathname;
        if (p.replace(/\\/g, '/').includes('tools/flowguard.ts'))
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        return realImpl(...args);
      }) as typeof fs.readFile);

      try {
        const checks = await doctor(repoArgs({ action: 'doctor' }));
        const toolCheck = checks.find(
          (c) => c.file === toolPath || c.file.replace(/\\/g, '/').includes('tools/flowguard.ts'),
        );
        expect(toolCheck).toBeDefined();
        expect(toolCheck!.status).toBe('error');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });

    it('reports error not missing when plugin wrapper is unreadable (EACCES)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const pluginPath = path.join(tmpDir, '.opencode', 'plugins', 'flowguard-audit.ts');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
        const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
        if (p.replace(/\\/g, '/').includes('plugins/flowguard-audit.ts'))
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        return realImpl(...args);
      }) as typeof fs.readFile);

      try {
        const checks = await doctor(repoArgs({ action: 'doctor' }));
        const pluginCheck = checks.find(
          (c) => c.file && c.file.replace(/\\/g, '/').includes('plugins/flowguard-audit.ts'),
        );
        expect(pluginCheck).toBeDefined();
        expect(pluginCheck!.status).toBe('error');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });

    it('reports error not missing when package.json is unreadable (EACCES)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
        const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
        if (p.replace(/\\/g, '/').includes('.opencode/package.json'))
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        return realImpl(...args);
      }) as typeof fs.readFile);

      try {
        const checks = await doctor(repoArgs({ action: 'doctor' }));
        const pkgCheck = checks.find(
          (c) => c.file && c.file.replace(/\\/g, '/').includes('.opencode/package.json'),
        );
        expect(pkgCheck).toBeDefined();
        expect(pkgCheck!.status).toBe('error');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });

    it('reports error not missing when command wrapper is unreadable (EACCES)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const cmdPath = path.join(tmpDir, '.opencode', 'commands', 'plan.md');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
        const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
        if (p.replace(/\\/g, '/').includes('commands/plan.md'))
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        return realImpl(...args);
      }) as typeof fs.readFile);

      try {
        const checks = await doctor(repoArgs({ action: 'doctor' }));
        const cmdCheck = checks.find(
          (c) => c.file && c.file.replace(/\\/g, '/').includes('commands/plan.md'),
        );
        expect(cmdCheck).toBeDefined();
        expect(cmdCheck!.status).toBe('error');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });

    it('reports error not missing when opencode.json is unreadable (EACCES)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const opencodePath = path.join(tmpDir, 'opencode.json');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      vi.mocked(fs.readFile).mockImplementation(((...args: Parameters<typeof fs.readFile>) => {
        const p = typeof args[0] === 'string' ? args[0] : String(args[0]);
        // Match opencode.json at project root, not inside .opencode/
        const norm = p.replace(/\\/g, '/');
        if (norm.endsWith('/opencode.json') && !norm.includes('.opencode/'))
          return Promise.reject(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
        return realImpl(...args);
      }) as typeof fs.readFile);

      try {
        const checks = await doctor(repoArgs({ action: 'doctor' }));
        const ocCheck = checks.find((c) => c.file && c.file.includes('opencode.json'));
        expect(ocCheck).toBeDefined();
        expect(ocCheck!.status).toBe('error');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });
  });

  // ─── CORNER ────────────────────────────────────────────────
  describe('CORNER', () => {
    it('detects modified tool wrapper', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const toolPath = path.join(tmpDir, '.opencode', 'tools', 'flowguard.ts');
      await fs.writeFile(toolPath, '// tampered content', 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const toolCheck = checks.find(
        (c) => c.file.includes('flowguard.ts') && c.file.includes('tools'),
      );
      expect(toolCheck?.status).toBe('modified');
    });

    // ─── P12 ──────────────────────────────────────────────────
    it('P12: missing plugin file reports missing', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const pluginPath = path.join(tmpDir, '.opencode', 'plugins', 'flowguard-audit.ts');
      await fs.unlink(pluginPath);

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const pluginCheck = checks.find((c) => c.file.includes('flowguard-audit.ts'));
      expect(pluginCheck?.status).toBe('missing');
    });

    it('P12: pending obligation without handshake reports error', async () => {
      const configDir = path.join(tmpDir, '.config', 'opencode');
      await fs.mkdir(configDir, { recursive: true });
      const prevDir = process.env.OPENCODE_CONFIG_DIR;
      process.env.OPENCODE_CONFIG_DIR = configDir;

      try {
        const { computeFingerprint } = await import('../adapters/workspace/fingerprint.js');
        const fp = await computeFingerprint(path.resolve(tmpDir));
        const sessionId = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';
        const sessionPath = path.join(
          configDir,
          'workspaces',
          fp.fingerprint,
          'sessions',
          sessionId,
        );
        await fs.mkdir(sessionPath, { recursive: true });

        await fs.writeFile(
          path.join(sessionPath, 'session-state.json'),
          JSON.stringify({
            reviewAssurance: {
              obligations: [{ status: 'pending' }],
            },
          }),
          'utf-8',
        );

        await fs.writeFile(
          path.join(configDir, 'SESSION_POINTER.json'),
          JSON.stringify({ sessionId, worktree: path.resolve(tmpDir) }),
          'utf-8',
        );

        const checks = await checkLastSessionHandshake('global');
        expect(checks.length).toBeGreaterThan(0);
        expect(checks[0].status).toBe('error');
        expect(checks[0].detail).toContain('plugin handshake');
      } finally {
        process.env.OPENCODE_CONFIG_DIR = prevDir;
      }
    });

    it('P12: checkLastSessionHandshake returns empty for repo scope', async () => {
      const checks = await checkLastSessionHandshake('repo');
      expect(checks).toEqual([]);
    });

    it('P12: invalid pointer (missing sessionId) reports warn', async () => {
      const configDir = path.join(tmpDir, '.config', 'opencode');
      await fs.mkdir(configDir, { recursive: true });
      const prevDir = process.env.OPENCODE_CONFIG_DIR;
      process.env.OPENCODE_CONFIG_DIR = configDir;

      try {
        await fs.writeFile(
          path.join(configDir, 'SESSION_POINTER.json'),
          JSON.stringify({ worktree: '/tmp/test' }),
          'utf-8',
        );
        const checks = await checkLastSessionHandshake('global');
        expect(checks.length).toBe(1);
        expect(checks[0].status).toBe('warn');
        expect(checks[0].detail).toContain('sessionId');
      } finally {
        process.env.OPENCODE_CONFIG_DIR = prevDir;
      }
    });

    it('P12: valid pointer but missing session-state reports warn', async () => {
      const configDir = path.join(tmpDir, '.config', 'opencode');
      await fs.mkdir(configDir, { recursive: true });
      const prevDir = process.env.OPENCODE_CONFIG_DIR;
      process.env.OPENCODE_CONFIG_DIR = configDir;

      try {
        const sessionId = 'aaaaaaaa-bbbb-4ccc-dddd-eeeeeeeeeeee';
        await fs.writeFile(
          path.join(configDir, 'SESSION_POINTER.json'),
          JSON.stringify({ sessionId, worktree: path.resolve(tmpDir) }),
          'utf-8',
        );

        const checks = await checkLastSessionHandshake('global');
        expect(checks.length).toBe(1);
        expect(checks[0].status).toBe('warn');
        expect(checks[0].detail).toContain('Session state');
      } finally {
        process.env.OPENCODE_CONFIG_DIR = prevDir;
      }
    });

    it('detects modified flowguard-mandates.md (digest mismatch)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
      const original = await fs.readFile(mandatesPath, 'utf-8');
      await fs.writeFile(mandatesPath, original + '\n# Extra section\n', 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const mandatesCheck = checks.find((c) => c.file.includes(MANDATES_FILENAME));
      expect(mandatesCheck?.status).toBe('modified');
      expect(mandatesCheck?.detail).toContain('digest mismatch');
    });

    it('detects unmanaged flowguard-mandates.md (no header)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const mandatesPath = path.join(tmpDir, '.opencode', MANDATES_FILENAME);
      await fs.writeFile(mandatesPath, '# Just a plain file\n', 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const mandatesCheck = checks.find((c) => c.file.includes(MANDATES_FILENAME));
      expect(mandatesCheck?.status).toBe('unmanaged');
    });

    it('detects missing @flowguard/core in package.json', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const pkgPath = path.join(tmpDir, '.opencode', 'package.json');
      const content = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      delete content.dependencies['@flowguard/core'];
      await fs.writeFile(pkgPath, JSON.stringify(content, null, 2), 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const pkgCheck = checks.find((c) => c.file.includes('package.json'));
      expect(pkgCheck?.status).toBe('error');
    });

    it('detects instruction_missing in opencode.json', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const ocPath = path.join(tmpDir, 'opencode.json');
      const content = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      content.instructions = ['other-stuff.md'];
      await fs.writeFile(ocPath, JSON.stringify(content, null, 2), 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const ocCheck = checks.find(
        (c) => c.file.includes('opencode.json') && c.status === 'instruction_missing',
      );
      expect(ocCheck).toBeDefined();
      expect(ocCheck?.detail).toContain(mandatesInstructionEntry('repo'));
    });

    it('detects instruction_stale (legacy AGENTS.md entry)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const ocPath = path.join(tmpDir, 'opencode.json');
      const content = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      content.instructions.push(LEGACY_INSTRUCTION_ENTRY);
      await fs.writeFile(ocPath, JSON.stringify(content, null, 2), 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const staleCheck = checks.find(
        (c) => c.file.includes('opencode.json') && c.status === 'instruction_stale',
      );
      expect(staleCheck).toBeDefined();
      expect(staleCheck?.detail).toContain('AGENTS.md');
    });

    it('reports missing config as error', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await fs.unlink(path.join(tmpDir, '.opencode', 'flowguard.json'));

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const configCheck = checks.find((c) =>
        c.file.replace(/\\/g, '/').endsWith('/flowguard.json'),
      );
      expect(configCheck?.status).toBe('error');
      expect(configCheck?.detail).toContain('CONFIG_MISSING');
    });

    it('does not create workspace.json when only flowguard.json is missing', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const { ensureWorkspace: findWs } = await import('../adapters/workspace/index.js');
      const { workspaceDir: wsDir } = await findWs(process.cwd());
      await fs.unlink(path.join(wsDir, 'workspace.json'));

      await doctor(repoArgs({ action: 'doctor' }));
      const recreated = existsSync(path.join(wsDir, 'workspace.json'));
      expect(recreated).toBe(false);
    });

    // ─── #106: scope-aware config check ───────────────────────
    it('#106: doctor --install-scope global with valid global config from inside a repo checks global', async () => {
      const tarball = await createMockTarball();
      // Install in repo scope (creates .opencode/flowguard.json)
      await install(repoArgs({ coreTarball: tarball }));
      // Also write a global config
      const { writeGlobalConfig } = await import('../adapters/persistence.js');
      const { DEFAULT_CONFIG } = await import('../config/flowguard-config.js');
      await writeGlobalConfig(structuredClone(DEFAULT_CONFIG));

      const checks = await doctor(globalArgs({ action: 'doctor' }));
      const configCheck = checks.find((c) =>
        c.file.replace(/\\/g, '/').endsWith('/flowguard.json'),
      );
      expect(configCheck).toBeDefined();
      expect(configCheck!.status).toBe('ok');
      // Should point to global path, not repo path
      expect(configCheck!.file.replace(/\\/g, '/')).not.toContain('.opencode/flowguard.json');
    });

    it('#106: doctor --install-scope global with missing global config reports CONFIG_MISSING even if cwd has repo config', async () => {
      const tarball = await createMockTarball();
      // Install in repo scope (creates .opencode/flowguard.json)
      await install(repoArgs({ coreTarball: tarball }));
      // Global config does NOT exist (tmpDir is OPENCODE_CONFIG_DIR, no flowguard.json there directly)
      // Note: install writes repo config to .opencode/flowguard.json, not global

      const checks = await doctor(globalArgs({ action: 'doctor' }));
      const configCheck = checks.find((c) => c.detail?.includes('CONFIG_MISSING'));
      expect(configCheck).toBeDefined();
      expect(configCheck!.status).toBe('error');
    });

    it('#106: doctor --install-scope repo with valid repo config reports ok', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const configCheck = checks.find((c) =>
        c.file.replace(/\\/g, '/').endsWith('/flowguard.json'),
      );
      expect(configCheck?.status).toBe('ok');
    });

    it('#106: doctor --install-scope repo with missing repo config reports CONFIG_MISSING', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Remove repo config
      await fs.unlink(path.join(tmpDir, '.opencode', 'flowguard.json'));

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const configCheck = checks.find((c) => c.detail?.includes('CONFIG_MISSING'));
      expect(configCheck).toBeDefined();
      expect(configCheck!.status).toBe('error');
    });

    it('#106: doctor --install-scope repo with missing repo config but valid global config still reports repo CONFIG_MISSING (no fallback)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Write global config
      const { writeGlobalConfig } = await import('../adapters/persistence.js');
      const { DEFAULT_CONFIG } = await import('../config/flowguard-config.js');
      await writeGlobalConfig(structuredClone(DEFAULT_CONFIG));
      // Remove repo config
      await fs.unlink(path.join(tmpDir, '.opencode', 'flowguard.json'));

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const configCheck = checks.find((c) => c.detail?.includes('CONFIG_MISSING'));
      expect(configCheck).toBeDefined();
      expect(configCheck!.status).toBe('error');
      expect(configCheck!.detail).toContain('repo config');
    });

    // ─── #107: desktop task-hardening warning ──────────────────
    it('#107: desktop config with plugin field and no task hardening reports warn', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Overwrite opencode.json to simulate desktop-owned config with plugin but no hardening
      const ocPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        ocPath,
        JSON.stringify(
          {
            plugin: ['flowguard-audit'],
            instructions: [mandatesInstructionEntry('repo')],
          },
          null,
          2,
        ),
        'utf-8',
      );

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const warnCheck = checks.find(
        (c) => c.status === 'warn' && c.detail?.includes('task hardening'),
      );
      expect(warnCheck).toBeDefined();
    });

    it('#107: desktop config with task hardening does not report warn', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const ocPath = path.join(tmpDir, 'opencode.json');
      const content = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      content.plugin = ['flowguard-audit'];
      content.agent = {
        build: {
          permission: {
            task: { '*': 'deny', 'flowguard-reviewer': 'allow' },
          },
        },
      };
      await fs.writeFile(ocPath, JSON.stringify(content, null, 2), 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const warnCheck = checks.find(
        (c) => c.status === 'warn' && c.detail?.includes('task hardening'),
      );
      expect(warnCheck).toBeUndefined();
    });

    it('#107: standard FlowGuard config (no plugin field) does not get task hardening warn', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Remove plugin field from opencode.json
      const ocPath = path.join(tmpDir, 'opencode.json');
      const content = JSON.parse(await fs.readFile(ocPath, 'utf-8'));
      delete content.plugin;
      await fs.writeFile(ocPath, JSON.stringify(content, null, 2), 'utf-8');

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const warnCheck = checks.find(
        (c) => c.status === 'warn' && c.detail?.includes('task hardening'),
      );
      expect(warnCheck).toBeUndefined();
    });

    it('#107: config with desktop instructions but no plugin field reports warn', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Overwrite: no plugin field, but has non-FlowGuard instruction → desktop-owned
      const ocPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        ocPath,
        JSON.stringify(
          {
            instructions: ['some-desktop-owned.md'],
          },
          null,
          2,
        ),
        'utf-8',
      );

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const warnCheck = checks.find(
        (c) => c.status === 'warn' && c.detail?.includes('task hardening'),
      );
      expect(warnCheck).toBeDefined();
    });

    it('#107: desktop config missing FlowGuard instruction still reports instruction_missing alongside warn', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      // Overwrite with desktop-owned config: has plugin, no instruction, no hardening
      const ocPath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        ocPath,
        JSON.stringify(
          {
            plugin: ['flowguard-audit'],
            instructions: [],
          },
          null,
          2,
        ),
        'utf-8',
      );

      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const missingCheck = checks.find((c) => c.status === 'instruction_missing');
      const warnCheck = checks.find(
        (c) => c.status === 'warn' && c.detail?.includes('task hardening'),
      );
      expect(missingCheck).toBeDefined();
      expect(warnCheck).toBeDefined();
    });
  });

  // ─── EDGE ─────────────────────────────────────────────────
  describe('EDGE', () => {
    it('doctor after uninstall reports all missing', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const missing = checks.filter((c) => c.status === 'missing');
      expect(missing.length).toBeGreaterThanOrEqual(Object.keys(COMMANDS).length + 3);
    });

    it('doctor reports "defaults only" for fresh install config (not customized)', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const cfgCheck = checks.find((c) => c.file.includes('flowguard.json') && c.status === 'ok');
      expect(cfgCheck?.detail).toContain('defaults only');
    });

    it('doctor reports CONFIG_MISSING after uninstall removes flowguard.json', async () => {
      const tarball = await createMockTarball();
      await install(repoArgs({ coreTarball: tarball }));
      await uninstall(repoArgs({ action: 'uninstall' }));
      const checks = await doctor(repoArgs({ action: 'doctor' }));
      const cfgCheck = checks.find(
        (c) => c.file.includes('flowguard.json') && c.detail?.includes('CONFIG_MISSING'),
      );
      expect(cfgCheck).toBeDefined();
    });
  });

  // ─── PERF ──────────────────────────────────────────────────
  describe('PERF', () => {
    it('doctor completes in < 200ms', async () => {
      await install(repoArgs());
      const { elapsedMs } = await measureAsync(async () => {
        await doctor(repoArgs({ action: 'doctor' }));
      });
      expect(elapsedMs).toBeLessThan(200);
    });
  });
});

// ─── hasNonFlowGuardInstructions ──────────────────────────────────────────────
describe('cli/hasNonFlowGuardInstructions', () => {
  it('returns false for empty array', () => {
    expect(hasNonFlowGuardInstructions([])).toBe(false);
  });

  it('returns false for FlowGuard-only entries', () => {
    expect(hasNonFlowGuardInstructions(['flowguard-mandates.md'])).toBe(false);
    expect(hasNonFlowGuardInstructions(['.opencode/flowguard-mandates.md'])).toBe(false);
    expect(hasNonFlowGuardInstructions(['AGENTS.md'])).toBe(false);
    expect(
      hasNonFlowGuardInstructions([
        'flowguard-mandates.md',
        '.opencode/flowguard-mandates.md',
        'AGENTS.md',
      ]),
    ).toBe(false);
  });

  it('returns true for non-FlowGuard entries', () => {
    expect(hasNonFlowGuardInstructions(['some-desktop-owned.md'])).toBe(true);
    expect(hasNonFlowGuardInstructions(['cursor-rules.md'])).toBe(true);
  });

  it('returns true when mixed with FlowGuard entries', () => {
    expect(hasNonFlowGuardInstructions(['flowguard-mandates.md', 'my-custom-rules.md'])).toBe(true);
  });

  it('uses exact match — substring of FlowGuard entry is desktop-owned', () => {
    // "my-flowguard-mandates-notes.md" contains "flowguard-mandates" as substring
    // but is NOT a FlowGuard-owned entry
    expect(hasNonFlowGuardInstructions(['my-flowguard-mandates-notes.md'])).toBe(true);
    expect(hasNonFlowGuardInstructions(['AGENTS.md.backup'])).toBe(true);
  });

  it('FLOWGUARD_INSTRUCTION_ENTRIES contains exactly the known entries', () => {
    expect(FLOWGUARD_INSTRUCTION_ENTRIES).toContain('flowguard-mandates.md');
    expect(FLOWGUARD_INSTRUCTION_ENTRIES).toContain('.opencode/flowguard-mandates.md');
    expect(FLOWGUARD_INSTRUCTION_ENTRIES).toContain('AGENTS.md');
    expect(FLOWGUARD_INSTRUCTION_ENTRIES).toHaveLength(3);
  });
});
