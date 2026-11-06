/**
 * @module cli/install-helpers-core.test
 * @description Unit tests for install-helper functions — targets uncovered branches.
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
    writeFile: vi.fn((...args: Parameters<typeof actual.writeFile>) => actual.writeFile(...args)),
    unlink: vi.fn((...args: Parameters<typeof actual.unlink>) => actual.unlink(...args)),
    rename: vi.fn((...args: Parameters<typeof actual.rename>) => actual.rename(...args)),
  };
});

import {
  sha256,
  safeRead,
  safeUnlink,
  resolveOpencodeConfigPath,
  writeIfAbsent,
  detectInstalledArtifacts,
} from './install-helpers.js';
import { MANDATES_FILENAME, PLUGIN_RELATIVE_PATH } from './templates.js';
import { rollbackArtifacts } from './install-helpers-rollback.js';
import { PACKAGE_VERSION } from './install-types.js';
import {
  createMalformedJsonBackup,
  mergePackageJson,
  parseJsonc,
  vendorDependency,
} from './install-json.js';

describe('install-helpers', () => {
  let tmpDir: string;

  async function findBackupFor(filePath: string): Promise<string | null> {
    const entries = await fs.readdir(path.dirname(filePath));
    const prefix = `${path.basename(filePath)}.flowguard-backup-`;
    const backup = entries.find((entry) => entry.startsWith(prefix));
    return backup ? path.join(path.dirname(filePath), backup) : null;
  }

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-install-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('PACKAGE_VERSION', () => {
    it('returns a non-empty cached string', () => {
      const first = PACKAGE_VERSION();
      expect(first).toBeTruthy();
      expect(first).toBe(PACKAGE_VERSION());
    });
  });

  describe('sha256', () => {
    it('returns a deterministic 64-char hex digest', () => {
      expect(sha256('hello')).toBe(sha256('hello'));
      expect(sha256('hello')).not.toBe(sha256('world'));
      expect(sha256('test')).toHaveLength(64);
    });
  });

  describe('vendorDependency', () => {
    it('returns file:-path with version', () => {
      expect(vendorDependency('1.0.0')).toBe('file:./vendor/flowguard-core-1.0.0.tgz');
    });
  });

  describe('mergePackageJson', () => {
    it('writes new package.json when file does not exist', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('written');
      expect(await fs.readFile(pkgPath, 'utf-8')).toContain('@flowguard/core');
    });

    it('merges FlowGuard dependencies while preserving customer dependencies', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      await fs.writeFile(
        pkgPath,
        JSON.stringify({
          name: 'test',
          dependencies: {
            '@opencode-ai/plugin': '^9.9.9',
            'customer-dependency': '^1.0.0',
          },
        }),
      );

      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(content.name).toBe('test');
      expect(content.dependencies['@flowguard/core']).toBeDefined();
      expect(content.dependencies['@opencode-ai/plugin']).toBe('^9.9.9');
      expect(content.dependencies['customer-dependency']).toBe('^1.0.0');
    });

    it('backs up malformed JSON before replacing it', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      const malformed = '{ not valid json }';
      await fs.writeFile(pkgPath, malformed);

      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('written');
      expect(result.reason).toContain('.flowguard-backup-');

      const backupPath = await findBackupFor(pkgPath);
      expect(backupPath).not.toBeNull();
      await expect(fs.readFile(backupPath!, 'utf-8')).resolves.toBe(malformed);
      expect(await fs.readFile(pkgPath, 'utf-8')).toContain('@flowguard/core');
    });

    it('blocks malformed package replacement when backup creation fails', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      const malformed = '{ not valid json }';
      await fs.writeFile(pkgPath, malformed);
      const realImpl = vi.mocked(fs.writeFile).getMockImplementation()!;
      try {
        vi.mocked(fs.writeFile).mockImplementation(
          async (...args: Parameters<typeof fs.writeFile>) => {
            const options = args[2];
            if (typeof options === 'object' && options !== null && 'flag' in options) {
              throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
            }
            return realImpl(...args);
          },
        );
        await expect(mergePackageJson(pkgPath, '1.0.0')).rejects.toThrow('ENOSPC');
      } finally {
        vi.mocked(fs.writeFile).mockImplementation(realImpl);
      }
      await expect(fs.readFile(pkgPath, 'utf-8')).resolves.toBe(malformed);
    });
  });

  describe('safeRead / safeUnlink', () => {
    it('reads existing files and treats ENOENT as absence', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(filePath, 'hello', 'utf-8');
      await expect(safeRead(filePath)).resolves.toBe('hello');
      await expect(safeRead(path.join(tmpDir, 'missing.txt'))).resolves.toBeNull();
    });

    it('deletes existing files and treats ENOENT as absence', async () => {
      const filePath = path.join(tmpDir, 'to-delete.txt');
      await fs.writeFile(filePath, 'x', 'utf-8');
      await expect(safeUnlink(filePath)).resolves.toBe(true);
      await expect(safeUnlink(filePath)).resolves.toBe(false);
    });

    it('propagates read permission errors', async () => {
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      try {
        vi.mocked(fs.readFile).mockRejectedValue(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        );
        await expect(safeRead(path.join(tmpDir, 'no-access.txt'))).rejects.toThrow('EACCES');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });

    it('propagates unlink permission errors', async () => {
      const realImpl = vi.mocked(fs.unlink).getMockImplementation()!;
      try {
        vi.mocked(fs.unlink).mockRejectedValue(
          Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
        );
        await expect(safeUnlink(path.join(tmpDir, 'locked.txt'))).rejects.toThrow('EPERM');
      } finally {
        vi.mocked(fs.unlink).mockImplementation(realImpl);
      }
    });
  });

  describe('rollbackArtifacts', () => {
    it('removes a fully journaled newly created directory tree', async () => {
      const rollbackRoot = path.join(tmpDir, 'created');
      const nested = path.join(rollbackRoot, 'nested');
      const artifact = path.join(nested, 'artifact.txt');
      await fs.mkdir(nested, { recursive: true });
      await fs.writeFile(artifact, 'artifact', 'utf-8');
      const ops: Array<{ path: string; action: 'removed'; reason: string }> = [];
      const errors: string[] = [];

      await rollbackArtifacts(
        [
          { path: rollbackRoot, existed: false, expectedKind: 'directory', sequence: 1 },
          { path: nested, existed: false, expectedKind: 'directory', sequence: 2 },
          { path: artifact, existed: false, expectedKind: 'file', sequence: 3 },
        ],
        ops,
        errors,
      );

      await expect(fs.lstat(rollbackRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(errors).toEqual([]);
      expect(ops).toHaveLength(3);
    });

    it('preserves an unjournaled foreign file inside a newly created directory', async () => {
      const rollbackRoot = path.join(tmpDir, 'created');
      const foreignFile = path.join(rollbackRoot, 'foreign.txt');
      await fs.mkdir(rollbackRoot);
      await fs.writeFile(foreignFile, 'external content', 'utf-8');
      const ops: Array<{ path: string; action: 'removed'; reason: string }> = [];
      const errors: string[] = [];

      await rollbackArtifacts(
        [{ path: rollbackRoot, existed: false, expectedKind: 'directory', sequence: 1 }],
        ops,
        errors,
      );

      expect(errors.join('\n')).toContain('did not journal as its own');
      await expect(fs.readFile(foreignFile, 'utf-8')).resolves.toBe('external content');
      expect(ops).toEqual([]);
    });

    it('rejects a symlink swapped into a newly created rollback target', async () => {
      const externalFile = path.join(tmpDir, 'external.txt');
      const rollbackPath = path.join(tmpDir, 'created.txt');
      await fs.writeFile(externalFile, 'must remain intact', 'utf-8');
      await fs.symlink(externalFile, rollbackPath);
      const errors: string[] = [];

      await rollbackArtifacts(
        [{ path: rollbackPath, existed: false, expectedKind: 'file', sequence: 1 }],
        [],
        errors,
      );

      expect(errors.join('\n')).toContain('replaced by a symlink');
      await expect(fs.readFile(externalFile, 'utf-8')).resolves.toBe('must remain intact');
    });

    it('preserves a symlink inside a newly created rollback directory', async () => {
      const rollbackRoot = path.join(tmpDir, 'created');
      const externalFile = path.join(tmpDir, 'external.txt');
      await fs.mkdir(rollbackRoot);
      await fs.writeFile(externalFile, 'must remain intact', 'utf-8');
      await fs.symlink(externalFile, path.join(rollbackRoot, 'link.txt'));
      const errors: string[] = [];

      await rollbackArtifacts(
        [{ path: rollbackRoot, existed: false, expectedKind: 'directory', sequence: 1 }],
        [],
        errors,
      );

      // Non-empty after removing journaled content: preserved, never traversed.
      expect(errors.join('\n')).toContain('did not journal as its own');
      await expect(fs.readFile(externalFile, 'utf-8')).resolves.toBe('must remain intact');
      await expect(fs.lstat(path.join(rollbackRoot, 'link.txt'))).resolves.toMatchObject({});
    });
  });

  describe('createMalformedJsonBackup', () => {
    it('creates a timestamped backup with exact original content', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const malformed = '{ this is not valid json }';
      const backupPath = await createMalformedJsonBackup(
        filePath,
        malformed,
        new Date('2026-05-16T14:30:12.123Z'),
      );
      expect(backupPath).toBe(`${filePath}.flowguard-backup-20260516T143012123Z`);
      await expect(fs.readFile(backupPath, 'utf-8')).resolves.toBe(malformed);
    });
  });

  describe('resolveOpencodeConfigPath', () => {
    it('resolves global config from the explicit target rather than the project', async () => {
      const target = path.join(tmpDir, 'global');
      await fs.mkdir(target);
      await fs.writeFile(path.join(target, 'opencode.jsonc'), '{}');
      expect(resolveOpencodeConfigPath('global', target, tmpDir)).toBe(
        path.join(target, 'opencode.jsonc'),
      );
    });
    it('creates opencode.json path when no config exists', () => {
      expect(resolveOpencodeConfigPath('repo', undefined, tmpDir)).toBe(
        path.join(tmpDir, 'opencode.json'),
      );
    });

    it('prefers opencode.jsonc over opencode.json', async () => {
      await fs.writeFile(path.join(tmpDir, 'opencode.json'), '{}', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'opencode.jsonc'), '{}', 'utf-8');
      expect(resolveOpencodeConfigPath('repo', undefined, tmpDir)).toBe(
        path.join(tmpDir, 'opencode.jsonc'),
      );
    });
  });

  describe('native artifact detection', () => {
    it.each([
      {
        platform: 'opencode' as const,
        files: [MANDATES_FILENAME, PLUGIN_RELATIVE_PATH, 'flowguard.json'],
      },
      {
        platform: 'claude-code' as const,
        files: [
          'flowguard-plugin/.claude-plugin/plugin.json',
          '.mcp.json',
          'hooks/hooks.json',
          'flowguard-plugin/agents/flowguard-reviewer.md',
        ],
      },
      {
        platform: 'codex' as const,
        files: [
          '.codex-plugin/plugin.json',
          '.mcp.json',
          'hooks/hooks.json',
          'subagents/flowguard-reviewer.md',
        ],
      },
    ])(
      'distinguishes empty, partial and complete $platform artifacts without fabricating presence',
      async ({ platform, files }) => {
        expect(detectInstalledArtifacts(tmpDir, platform)).toEqual({ found: false, artifacts: [] });
        for (const [index, file] of files.entries()) {
          const full = path.join(tmpDir, file);
          await fs.mkdir(path.dirname(full), { recursive: true });
          await fs.writeFile(full, 'fixture');
          expect(detectInstalledArtifacts(tmpDir, platform)).toEqual({
            found: true,
            artifacts: files.slice(0, index + 1),
          });
        }
      },
    );
  });

  describe('owned file writes', () => {
    it.each([false, true])(
      'creates missing parent directories before writing, force=%s',
      async (force) => {
        const file = path.join(tmpDir, 'missing', 'nested', 'plugin.ts');
        expect((await writeIfAbsent(file, 'native definition', force)).action).toBe('written');
        expect(await fs.readFile(file, 'utf8')).toBe('native definition');
      },
    );
    it('preserves an existing file without force', async () => {
      const file = path.join(tmpDir, 'plugin.ts');
      await fs.writeFile(file, 'customer bytes');
      expect((await writeIfAbsent(file, 'replacement', false)).action).toBe('skipped');
      expect(await fs.readFile(file, 'utf8')).toBe('customer bytes');
    });
    it.each([
      new Error('plain failure'),
      Object.assign(new Error('permission failure'), { code: 'EPERM' }),
    ])(
      'surfaces non-EEXIST writes instead of treating them as existing files: %s',
      async (failure) => {
        vi.mocked(fs.writeFile).mockRejectedValueOnce(failure);
        await expect(writeIfAbsent(path.join(tmpDir, 'plugin.ts'), 'value', false)).rejects.toBe(
          failure,
        );
      },
    );
    it('uses an exclusive temporary write for force replacement', async () => {
      const file = path.join(tmpDir, 'plugin.ts');
      await fs.writeFile(file, 'old');
      vi.mocked(fs.writeFile).mockClear();
      expect((await writeIfAbsent(file, 'new', true)).action).toBe('written');
      expect(vi.mocked(fs.writeFile).mock.calls).toEqual([
        [expect.stringContaining(`${file}.tmp.`), 'new', { encoding: 'utf-8', flag: 'wx' }],
      ]);
      expect(await fs.readFile(file, 'utf8')).toBe('new');
    });
    it('preserves the destination and removes its temporary file after rename failure', async () => {
      const file = path.join(tmpDir, 'plugin.ts');
      await fs.writeFile(file, 'old');
      const failure = new Error('rename failed');
      vi.mocked(fs.rename).mockRejectedValueOnce(failure);
      await expect(writeIfAbsent(file, 'new', true)).rejects.toBe(failure);
      expect(await fs.readFile(file, 'utf8')).toBe('old');
      expect(await fs.readdir(tmpDir)).toEqual(['plugin.ts']);
    });
  });

  describe('parseJsonc', () => {
    it('parses comments and trailing commas', () => {
      expect(parseJsonc<{ model: string }>('{ // c\n"model": "claude", }').model).toBe('claude');
      expect(parseJsonc<{ arr: number[] }>('{ "arr": [1, 2, 3, ], }').arr).toEqual([1, 2, 3]);
    });

    it('throws on malformed input', () => {
      expect(() => parseJsonc('not json')).toThrow(SyntaxError);
    });
  });

  // Native OpenCode config preservation/rejection is exercised through the
  // real installer in opencode-runtime-gate-install.test.ts; there is no merge API.
});
