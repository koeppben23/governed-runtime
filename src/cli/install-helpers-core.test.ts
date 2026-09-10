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
  };
});

import {
  mergePackageJson,
  mergeReviewerTaskPermission,
  mergeOpencodeJson,
  PACKAGE_VERSION,
  sha256,
  vendorDependency,
  safeRead,
  safeUnlink,
  resolveOpencodeConfigPath,
  parseJsonc,
  createMalformedJsonBackup,
  rollbackArtifacts,
} from './install-helpers.js';

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

  describe('mergeReviewerTaskPermission', () => {
    it('hardens a FlowGuard-owned task permission map', () => {
      const parsed: Record<string, unknown> = {};
      mergeReviewerTaskPermission(parsed);
      const agent = parsed.agent as Record<string, unknown>;
      const build = agent.build as Record<string, unknown>;
      const permission = build.permission as Record<string, unknown>;
      expect(permission.task).toEqual({ '*': 'deny', 'flowguard-reviewer': 'allow' });
    });

    it('preserves an explicit wildcard while adding the reviewer permission', () => {
      const parsed = {
        agent: { build: { permission: { task: { '*': 'allow', 'customer-agent': 'ask' } } } },
      };
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      expect(parsed.agent.build.permission.task).toEqual({
        '*': 'allow',
        'customer-agent': 'ask',
        'flowguard-reviewer': 'allow',
      });
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
    it('removes a newly created directory tree using explicit recursion', async () => {
      const rollbackRoot = path.join(tmpDir, 'created');
      await fs.mkdir(path.join(rollbackRoot, 'nested'), { recursive: true });
      await fs.writeFile(path.join(rollbackRoot, 'nested', 'artifact.txt'), 'artifact', 'utf-8');
      const ops: Array<{ path: string; action: 'removed'; reason: string }> = [];
      const errors: string[] = [];

      await rollbackArtifacts(
        [{ path: rollbackRoot, existed: false, expectedKind: 'directory', sequence: 1 }],
        ops,
        errors,
      );

      await expect(fs.lstat(rollbackRoot)).rejects.toMatchObject({ code: 'ENOENT' });
      expect(errors).toEqual([]);
      expect(ops).toHaveLength(1);
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

    it('rejects a symlink inside a newly created rollback directory', async () => {
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

      expect(errors.join('\n')).toContain('contains a symlink');
      await expect(fs.readFile(externalFile, 'utf-8')).resolves.toBe('must remain intact');
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

  describe('parseJsonc', () => {
    it('parses comments and trailing commas', () => {
      expect(parseJsonc<{ model: string }>('{ // c\n"model": "claude", }').model).toBe(
        'claude',
      );
      expect(parseJsonc<{ arr: number[] }>('{ "arr": [1, 2, 3, ], }').arr).toEqual([1, 2, 3]);
    });

    it('throws on malformed input', () => {
      expect(() => parseJsonc('not json')).toThrow(SyntaxError);
    });
  });

  describe('mergeOpencodeJson — ownership boundary', () => {
    it('customer config with plugin field receives only the FlowGuard instruction', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const input = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['opencode-helicone-session'],
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(input, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));

      expect(result.action).toBe('merged');
      expect(result.reason).toContain('preserved task permissions');
      expect(content.plugin).toEqual(input.plugin);
      expect(content.instructions).toContain('.opencode/flowguard-mandates.md');
      expect(content.agent).toBeUndefined();
    });

    it('customer instructions remain untouched while FlowGuard appends its instruction', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const input = {
        instructions: ['custom-rules.md', 'CONTRIBUTING.md'],
      };
      await fs.writeFile(filePath, JSON.stringify(input, null, 2), 'utf-8');

      await mergeOpencodeJson(filePath, 'repo');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));

      expect(content.instructions).toEqual([
        'custom-rules.md',
        'CONTRIBUTING.md',
        '.opencode/flowguard-mandates.md',
      ]);
      expect(content.agent).toBeUndefined();
    });

    it('FlowGuard-owned config gets reviewer task hardening', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        filePath,
        JSON.stringify({ $schema: 'https://opencode.ai/config.json', instructions: [] }),
        'utf-8',
      );

      await mergeOpencodeJson(filePath, 'repo');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('customer task permissions are preserved byte-for-value', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const customerTask = { '*': 'allow', 'customer-agent': 'ask' };
      await fs.writeFile(
        filePath,
        JSON.stringify({
          plugin: ['x'],
          instructions: [],
          agent: { build: { permission: { task: customerTask } } },
        }),
        'utf-8',
      );

      await mergeOpencodeJson(filePath, 'repo');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent.build.permission.task).toEqual(customerTask);
    });

    it('repeated customer-owned merges are idempotent', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(
        filePath,
        JSON.stringify({ plugin: ['x'], instructions: ['user-rules.md'] }),
        'utf-8',
      );

      await mergeOpencodeJson(filePath, 'repo');
      await mergeOpencodeJson(filePath, 'repo');
      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.instructions).toEqual(['user-rules.md', '.opencode/flowguard-mandates.md']);
      expect(content.agent).toBeUndefined();
    });
  });

  describe('mergeOpencodeJson — JSONC support', () => {
    it('parses JSONC with line comments', async () => {
      const filePath = path.join(tmpDir, 'opencode.jsonc');
      await fs.writeFile(
        filePath,
        '{ // comment\n "$schema": "https://opencode.ai/config.json", "model": "anthropic/claude" }',
        'utf-8',
      );
      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');
      expect(JSON.parse(await fs.readFile(filePath, 'utf-8')).model).toBe('anthropic/claude');
    });

    it('preserves comment-like text inside string values', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      await fs.writeFile(filePath, '{ "instructions": ["path/with//slashes.md"] }', 'utf-8');
      await mergeOpencodeJson(filePath, 'repo');
      expect(JSON.parse(await fs.readFile(filePath, 'utf-8')).instructions).toContain(
        'path/with//slashes.md',
      );
    });

    it('backs up malformed config before replacing it', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const malformed = 'this is not json at all {{{{';
      await fs.writeFile(filePath, malformed, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('written');
      expect(result.reason).toContain('backup');
      const backupPath = await findBackupFor(filePath);
      expect(backupPath).not.toBeNull();
      await expect(fs.readFile(backupPath!, 'utf-8')).resolves.toBe(malformed);
      expect(() => JSON.parse(await fs.readFile(filePath, 'utf-8'))).not.toThrow();
    });

    it('blocks malformed config replacement when backup creation fails', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const malformed = 'this is not json at all {{{{';
      await fs.writeFile(filePath, malformed, 'utf-8');
      const realImpl = vi.mocked(fs.writeFile).getMockImplementation()!;
      try {
        vi.mocked(fs.writeFile).mockImplementation(
          async (...args: Parameters<typeof fs.writeFile>) => {
            const options = args[2];
            if (typeof options === 'object' && options !== null && 'flag' in options) {
              throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
            }
            return realImpl(...args);
          },
        );
        await expect(mergeOpencodeJson(filePath, 'repo')).rejects.toThrow('EACCES');
      } finally {
        vi.mocked(fs.writeFile).mockImplementation(realImpl);
      }
      await expect(fs.readFile(filePath, 'utf-8')).resolves.toBe(malformed);
    });
  });
});
