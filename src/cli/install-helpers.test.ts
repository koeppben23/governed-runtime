/**
 * @module cli/install-helpers.test
 * @description Unit tests for install-helper functions — targets uncovered branches.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { withTestEnv } from '../integration/test-helpers.js';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
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
  buildReviewerAgentContent,
  FLOWGUARD_REVIEWER_MODEL_ENV,
  verifyTarballChecksum,
} from './install-helpers.js';
import { REVIEWER_AGENT } from './templates.js';
import { hashFile } from '../shared/hashing.js';

describe('install-helpers', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-install-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('PACKAGE_VERSION', () => {
    it('returns a non-empty string', () => {
      expect(PACKAGE_VERSION()).toBeTruthy();
      expect(PACKAGE_VERSION().length).toBeGreaterThan(0);
    });

    it('returns same value across multiple calls (cached)', () => {
      const a = PACKAGE_VERSION();
      const b = PACKAGE_VERSION();
      expect(a).toBe(b);
    });
  });

  describe('sha256', () => {
    it('returns deterministic hex digest', () => {
      expect(sha256('hello')).toBe(sha256('hello'));
    });

    it('returns different digests for different inputs', () => {
      expect(sha256('hello')).not.toBe(sha256('world'));
    });

    it('returns 64-char hex string', () => {
      expect(sha256('test')).toHaveLength(64);
    });
  });

  describe('vendorDependency', () => {
    it('returns file:-path with version', () => {
      const dep = vendorDependency('1.0.0');
      expect(dep).toBe('file:./vendor/flowguard-core-1.0.0.tgz');
    });
  });

  describe('mergePackageJson', () => {
    it('writes new package.json when file does not exist', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('written');

      const content = await fs.readFile(pkgPath, 'utf-8');
      expect(content).toContain('@flowguard/core');
    });

    it('merges into existing package.json', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      await fs.writeFile(pkgPath, JSON.stringify({ name: 'test' }));

      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(pkgPath, 'utf-8'));
      expect(content.name).toBe('test');
      expect(content.dependencies).toBeDefined();
      expect(content.dependencies['@flowguard/core']).toBeDefined();
    });

    it('handles malformed JSON by overwriting', async () => {
      const pkgPath = path.join(tmpDir, 'package.json');
      // Covers catch block: malformed JSON → overwrite with template
      await fs.writeFile(pkgPath, '{ not valid json }');

      const result = await mergePackageJson(pkgPath, '1.0.0');
      expect(result.action).toBe('written');
      expect(result.reason).toContain('malformed');

      const content = await fs.readFile(pkgPath, 'utf-8');
      expect(content).toContain('@flowguard/core');
    });
  });

  describe('mergeReviewerTaskPermission', () => {
    it('sets task permission to *.deny + flowguard-reviewer.allow', () => {
      const parsed = {};
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      const task = (parsed as Record<string, unknown>).agent as Record<string, unknown>;
      const build = task.build as Record<string, unknown>;
      const perm = build.permission as Record<string, unknown>;
      expect(perm.task).toEqual({ '*': 'deny', 'flowguard-reviewer': 'allow' });
    });

    it('handles empty agent config', () => {
      const parsed = {};
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      expect(parsed).toHaveProperty('agent');
    });

    it('handles partial config with existing agent but no build', () => {
      const parsed = { agent: { model: 'gpt-4' } as Record<string, unknown> };
      mergeReviewerTaskPermission(parsed as Record<string, unknown>);
      const agent = parsed.agent as Record<string, unknown>;
      expect(agent.build).toBeDefined();
    });
  });

  describe('safeRead / safeUnlink', () => {
    it('HAPPY: safeRead returns content of existing file', async () => {
      const filePath = path.join(tmpDir, 'test.txt');
      await fs.writeFile(filePath, 'hello', 'utf-8');
      const result = await safeRead(filePath);
      expect(result).toBe('hello');
    });

    it('HAPPY: safeRead returns null for missing file (ENOENT)', async () => {
      const result = await safeRead(path.join(tmpDir, 'nonexistent.txt'));
      expect(result).toBeNull();
    });

    it('HAPPY: safeUnlink returns true when file deleted', async () => {
      const filePath = path.join(tmpDir, 'to-delete.txt');
      await fs.writeFile(filePath, 'x', 'utf-8');
      const result = await safeUnlink(filePath);
      expect(result).toBe(true);
    });

    it('HAPPY: safeUnlink returns false for missing file (ENOENT)', async () => {
      const result = await safeUnlink(path.join(tmpDir, 'nonexistent.txt'));
      expect(result).toBe(false);
    });

    it('BAD: safeRead throws on permission error (EACCES)', async () => {
      const filePath = path.join(tmpDir, 'no-access.txt');
      await fs.writeFile(filePath, 'secret', 'utf-8');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      try {
        vi.mocked(fs.readFile).mockRejectedValue(
          Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
        );
        await expect(safeRead(filePath)).rejects.toThrow('EACCES');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });

    it('BAD: safeUnlink throws on permission error (EPERM)', async () => {
      const filePath = path.join(tmpDir, 'locked.txt');
      await fs.writeFile(filePath, 'x', 'utf-8');
      const realImpl = vi.mocked(fs.unlink).getMockImplementation()!;
      try {
        vi.mocked(fs.unlink).mockRejectedValue(
          Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' }),
        );
        await expect(safeUnlink(filePath)).rejects.toThrow('EPERM');
      } finally {
        vi.mocked(fs.unlink).mockImplementation(realImpl);
      }
    });

    it('BAD: safeRead throws on unexpected filesystem error (EIO)', async () => {
      const filePath = path.join(tmpDir, 'io-error.txt');
      await fs.writeFile(filePath, 'data', 'utf-8');
      const realImpl = vi.mocked(fs.readFile).getMockImplementation()!;
      try {
        vi.mocked(fs.readFile).mockRejectedValue(
          Object.assign(new Error('EIO: input/output error'), { code: 'EIO' }),
        );
        await expect(safeRead(filePath)).rejects.toThrow('EIO');
      } finally {
        vi.mocked(fs.readFile).mockImplementation(realImpl);
      }
    });
  });

  describe('resolveOpencodeConfigPath', () => {
    it('HAPPY: creates opencode.json when no config exists', () => {
      expect(resolveOpencodeConfigPath('repo', undefined, tmpDir)).toBe(
        path.join(tmpDir, 'opencode.json'),
      );
    });

    it('CORNER: prefers opencode.jsonc over opencode.json', async () => {
      await fs.writeFile(path.join(tmpDir, 'opencode.json'), '{}', 'utf-8');
      await fs.writeFile(path.join(tmpDir, 'opencode.jsonc'), '{}', 'utf-8');

      expect(resolveOpencodeConfigPath('repo', undefined, tmpDir)).toBe(
        path.join(tmpDir, 'opencode.jsonc'),
      );
    });
  });

  describe('parseJsonc', () => {
    it('HAPPY: parses JSONC with line comments', () => {
      const result = parseJsonc<{ model: string }>('{ // comment\n"model": "claude" }');
      expect(result.model).toBe('claude');
    });

    it('HAPPY: parses JSONC with block comments', () => {
      const result = parseJsonc<{ model: string }>('{ /* comment */ "model": "claude" }');
      expect(result.model).toBe('claude');
    });

    it('HAPPY: parses trailing commas (full JSONC compat per OpenCode docs)', () => {
      const result = parseJsonc<{ a: number }>('{ "a": 1, }');
      expect(result.a).toBe(1);
    });

    it('HAPPY: parses nested trailing commas', () => {
      const result = parseJsonc<{ arr: number[] }>('{ "arr": [1, 2, 3, ], }');
      expect(result.arr).toEqual([1, 2, 3]);
    });

    it('BAD: throws on truly malformed input', () => {
      expect(() => parseJsonc('not json')).toThrow(SyntaxError);
    });
  });

  // ÔöÇÔöÇÔöÇ Fix 4: Task-Hardening in desktop-owned configs ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('mergeOpencodeJson ÔÇö desktop-owned config task hardening (P35-fix)', () => {
    it('HAPPY: desktop-owned config with plugin field gets task permission', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['opencode-helicone-session'],
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');
      expect(result.reason).toContain('task permission');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('HAPPY: desktop-owned config with non-FlowGuard instructions gets task permission', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        instructions: ['custom-rules.md', 'CONTRIBUTING.md'],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('HAPPY: standard config (no plugin, no foreign instructions) also gets task permission', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const standardConfig = {
        $schema: 'https://opencode.ai/config.json',
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(standardConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('EDGE: desktop-owned config with BOTH plugin AND non-FG instructions', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['some-plugin'],
        instructions: ['user-rules.md'],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      // Task permission MUST be enforced even in this case
      expect(content.agent?.build?.permission?.task?.['*']).toBe('deny');
      expect(content.agent?.build?.permission?.task?.['flowguard-reviewer']).toBe('allow');
    });

    it('CORNER: idempotent ÔÇö repeated calls do not stack or corrupt', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['x'],
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      // Run twice
      await mergeOpencodeJson(filePath, 'repo');
      await mergeOpencodeJson(filePath, 'repo');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
      // No duplicate instruction entries
      const instructions = content.instructions as string[];
      const mandateEntries = instructions.filter((i: string) => i.includes('flowguard'));
      expect(mandateEntries.length).toBeLessThanOrEqual(1);
    });

    it('EDGE: desktop-owned config with pre-existing agent.build.permission.task gets overwritten', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['x'],
        instructions: [],
        agent: {
          build: {
            permission: {
              task: { '*': 'allow' }, // dangerous ÔÇö must be overwritten
            },
          },
        },
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      await mergeOpencodeJson(filePath, 'repo');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      // FlowGuard MUST enforce strict policy regardless of pre-existing config
      expect(content.agent.build.permission.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });
  });

  // ÔöÇÔöÇÔöÇ Fix 5: JSONC support in mergeOpencodeJson ÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇÔöÇ
  describe('mergeOpencodeJson ÔÇö JSONC support', () => {
    it('HAPPY: parses JSONC file with line comments', async () => {
      const filePath = path.join(tmpDir, 'opencode.jsonc');
      const jsoncContent = `{
  // This is a comment
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5"
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.model).toBe('anthropic/claude-sonnet-4-5');
      expect(content.instructions).toBeDefined();
    });

    it('HAPPY: parses JSONC file with block comments', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const jsoncContent = `{
  /* Block comment */
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["existing.md"]
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.instructions).toContain('existing.md');
    });

    it('HAPPY: trailing commas are parsed correctly (full JSONC compat)', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const jsoncContent = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      // Trailing commas are valid JSONC per OpenCode docs ÔÇö should merge, not fallback.
      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.model).toBe('anthropic/claude-sonnet-4-5');
      expect(content['$schema']).toBe('https://opencode.ai/config.json');
    });

    it('BAD: truly malformed content creates backup before overwriting', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const malformed = 'this is not json at all {{{{';
      await fs.writeFile(filePath, malformed, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('written');
      expect(result.reason).toContain('backup');

      // Verify backup file exists with original content
      const backupPath = `${filePath}.flowguard-backup`;
      const backupContent = await fs.readFile(backupPath, 'utf-8');
      expect(backupContent).toBe(malformed);

      // Verify the new file is valid JSON with FlowGuard template
      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(() => JSON.parse(newContent)).not.toThrow();
    });

    it('CORNER: JSONC with comments inside string values (should preserve)', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      // Comments inside strings must NOT be stripped
      const jsoncContent = `{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["path/with//slashes.md"]
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.instructions).toContain('path/with//slashes.md');
    });

    it('EDGE: file with only comments and empty object', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const jsoncContent = `// OpenCode config
/* auto-generated */
{}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content['$schema']).toBe('https://opencode.ai/config.json');
    });
  });

  // ─── Fix 4: Task-Hardening in desktop-owned configs ───────────────────────
  describe('mergeOpencodeJson — desktop-owned config task hardening (P35-fix)', () => {
    it('HAPPY: desktop-owned config with plugin field gets task permission', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['opencode-helicone-session'],
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');
      expect(result.reason).toContain('task permission');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('HAPPY: desktop-owned config with non-FlowGuard instructions gets task permission', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        instructions: ['custom-rules.md', 'CONTRIBUTING.md'],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('HAPPY: standard config (no plugin, no foreign instructions) also gets task permission', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const standardConfig = {
        $schema: 'https://opencode.ai/config.json',
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(standardConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });

    it('EDGE: desktop-owned config with BOTH plugin AND non-FG instructions', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['some-plugin'],
        instructions: ['user-rules.md'],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      // Task permission MUST be enforced even in this case
      expect(content.agent?.build?.permission?.task?.['*']).toBe('deny');
      expect(content.agent?.build?.permission?.task?.['flowguard-reviewer']).toBe('allow');
    });

    it('CORNER: idempotent — repeated calls do not stack or corrupt', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['x'],
        instructions: [],
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      // Run twice
      await mergeOpencodeJson(filePath, 'repo');
      await mergeOpencodeJson(filePath, 'repo');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.agent?.build?.permission?.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
      // No duplicate instruction entries
      const instructions = content.instructions as string[];
      const mandateEntries = instructions.filter((i: string) => i.includes('flowguard'));
      expect(mandateEntries.length).toBeLessThanOrEqual(1);
    });

    it('EDGE: desktop-owned config with pre-existing agent.build.permission.task gets overwritten', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const desktopConfig = {
        $schema: 'https://opencode.ai/config.json',
        plugin: ['x'],
        instructions: [],
        agent: {
          build: {
            permission: {
              task: { '*': 'allow' }, // dangerous — must be overwritten
            },
          },
        },
      };
      await fs.writeFile(filePath, JSON.stringify(desktopConfig, null, 2), 'utf-8');

      await mergeOpencodeJson(filePath, 'repo');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      // FlowGuard MUST enforce strict policy regardless of pre-existing config
      expect(content.agent.build.permission.task).toEqual({
        '*': 'deny',
        'flowguard-reviewer': 'allow',
      });
    });
  });

  // ─── Fix 5: JSONC support in mergeOpencodeJson ────────────────────────────
  describe('mergeOpencodeJson — JSONC support', () => {
    it('HAPPY: parses JSONC file with line comments', async () => {
      const filePath = path.join(tmpDir, 'opencode.jsonc');
      const jsoncContent = `{
  // This is a comment
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5"
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.model).toBe('anthropic/claude-sonnet-4-5');
      expect(content.instructions).toBeDefined();
    });

    it('HAPPY: parses JSONC file with block comments', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const jsoncContent = `{
  /* Block comment */
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["existing.md"]
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.instructions).toContain('existing.md');
    });

    it('HAPPY: parses trailing commas (full JSONC compat per OpenCode docs)', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const jsoncContent = `{
  "$schema": "https://opencode.ai/config.json",
  "model": "anthropic/claude-sonnet-4-5",
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      // jsonc-parser handles trailing commas — file parses and merges successfully
      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.model).toBe('anthropic/claude-sonnet-4-5');
    });

    it('BAD: truly malformed content creates backup before overwriting', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const malformed = 'this is not json at all {{{{';
      await fs.writeFile(filePath, malformed, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('written');
      expect(result.reason).toContain('backup');

      // Verify backup file exists with original content
      const backupPath = `${filePath}.flowguard-backup`;
      const backupContent = await fs.readFile(backupPath, 'utf-8');
      expect(backupContent).toBe(malformed);

      // Verify the new file is valid JSON with FlowGuard template
      const newContent = await fs.readFile(filePath, 'utf-8');
      expect(() => JSON.parse(newContent)).not.toThrow();
    });

    it('CORNER: JSONC with comments inside string values (should preserve)', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      // Comments inside strings must NOT be stripped
      const jsoncContent = `{
  "$schema": "https://opencode.ai/config.json",
  "instructions": ["path/with//slashes.md"]
}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content.instructions).toContain('path/with//slashes.md');
    });

    it('EDGE: file with only comments and empty object', async () => {
      const filePath = path.join(tmpDir, 'opencode.json');
      const jsoncContent = `// OpenCode config
/* auto-generated */
{}`;
      await fs.writeFile(filePath, jsoncContent, 'utf-8');

      const result = await mergeOpencodeJson(filePath, 'repo');
      expect(result.action).toBe('merged');

      const content = JSON.parse(await fs.readFile(filePath, 'utf-8'));
      expect(content['$schema']).toBe('https://opencode.ai/config.json');
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// buildReviewerAgentContent — FLOWGUARD_REVIEWER_MODEL env var model injection
// ═══════════════════════════════════════════════════════════════════════════════

describe('buildReviewerAgentContent', () => {
  let restoreEnv: (() => void) | undefined;

  afterEach(() => {
    restoreEnv?.();
    restoreEnv = undefined;
  });

  // ─── HAPPY ──────────────────────────────────────────────────────────────────

  it('T11: returns template unchanged when FLOWGUARD_REVIEWER_MODEL absent', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: undefined });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toBe(REVIEWER_AGENT);
  });

  it('T13: injects model: into frontmatter when FLOWGUARD_REVIEWER_MODEL set', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'opencode/big-pickle' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toContain('model: opencode/big-pickle');
    expect(result).not.toBe(REVIEWER_AGENT);
  });

  it('T14: injected model: appears between --- and description:', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'gpt-5.2' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    const lines = result.split('\n');
    const dashIndex = lines.indexOf('---');
    const modelIndex = lines.findIndex((l) => l.startsWith('model:'));
    const descIndex = lines.findIndex((l) => l.startsWith('description:'));
    expect(dashIndex).toBe(0);
    expect(modelIndex).toBeGreaterThan(dashIndex);
    expect(modelIndex).toBeLessThan(descIndex);
  });

  // ─── BAD ────────────────────────────────────────────────────────────────────

  it('T12: returns template unchanged when FLOWGUARD_REVIEWER_MODEL is empty string', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toBe(REVIEWER_AGENT);
  });

  it('T12b: returns template unchanged when FLOWGUARD_REVIEWER_MODEL is whitespace only', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '   \t  ' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toBe(REVIEWER_AGENT);
  });

  it('T15: throws on newline in FLOWGUARD_REVIEWER_MODEL (YAML injection prevention)', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'bad-model\nhidden: false' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/newline characters/);
  });

  it('T15b: throws on carriage return in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'bad-model\rinjected: true' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/newline characters/);
  });

  it('T16: throws on invalid characters in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'model with spaces' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/invalid characters/);
  });

  it('T16b: throws on shell metacharacters in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '$(whoami)' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/invalid characters/);
  });

  it('T16c: throws on quotes in FLOWGUARD_REVIEWER_MODEL', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '"injected"' });
    expect(() => buildReviewerAgentContent(REVIEWER_AGENT)).toThrow(/invalid characters/);
  });

  // ─── CORNER ─────────────────────────────────────────────────────────────────

  it('T17: accepts valid model IDs with various characters', () => {
    const validIds = [
      'opencode/big-pickle',
      'gpt-5.2',
      'claude-sonnet-4.5',
      'anthropic/claude-sonnet-4.5',
      'google/gemini-3-pro',
      'org:team/model-v2',
      '@provider/model',
    ];
    for (const id of validIds) {
      const cleanup = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: id });
      try {
        const result = buildReviewerAgentContent(REVIEWER_AGENT);
        expect(result).toContain(`model: ${id}`);
      } finally {
        cleanup();
      }
    }
  });

  it('T18: REVIEWER_AGENT constant has no model: in frontmatter today', () => {
    // Guards against double-injection if the constant later adds a model: field.
    // If this test fails, buildReviewerAgentContent needs replace-or-insert logic.
    const frontmatterMatch = REVIEWER_AGENT.match(/^---\n([\s\S]*?)\n---/);
    expect(frontmatterMatch).not.toBeNull();
    const frontmatter = frontmatterMatch![1]!;
    expect(frontmatter).not.toMatch(/^model:/m);
  });

  // ─── EDGE ───────────────────────────────────────────────────────────────────

  it('EDGE: trims whitespace from model ID', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: '  opencode/big-pickle  ' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    expect(result).toContain('model: opencode/big-pickle');
    // No leading/trailing whitespace in the model value
    expect(result).not.toContain('model:   ');
  });

  it('EDGE: preserves rest of template unchanged', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'test-model' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    // Remove the injected model line and compare
    const withoutModel = result.replace('model: test-model\n', '');
    expect(withoutModel).toBe(REVIEWER_AGENT);
  });

  it('EDGE: handles template without newline gracefully', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: undefined });
    const result = buildReviewerAgentContent('no-newline');
    expect(result).toBe('no-newline');
  });

  it('EDGE: handles template without newline when env var set', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'some-model' });
    // Defensive: malformed template with no newline returns template unchanged
    const result = buildReviewerAgentContent('no-newline');
    expect(result).toBe('no-newline');
  });

  // ─── SMOKE ──────────────────────────────────────────────────────────────────

  it('SMOKE: env var constant matches expected name', () => {
    expect(FLOWGUARD_REVIEWER_MODEL_ENV).toBe('FLOWGUARD_REVIEWER_MODEL');
  });

  it('SMOKE: injected content is valid YAML frontmatter', () => {
    restoreEnv = withTestEnv({ [FLOWGUARD_REVIEWER_MODEL_ENV]: 'opencode/big-pickle' });
    const result = buildReviewerAgentContent(REVIEWER_AGENT);
    // Verify the frontmatter block is well-formed: starts with ---, ends with ---
    const lines = result.split('\n');
    expect(lines[0]).toBe('---');
    const closingDashIndex = lines.indexOf('---', 1);
    expect(closingDashIndex).toBeGreaterThan(1);
    // model: should be within the frontmatter block
    const modelLine = lines.findIndex((l) => l === 'model: opencode/big-pickle');
    expect(modelLine).toBeGreaterThan(0);
    expect(modelLine).toBeLessThan(closingDashIndex);
  });
});

// ─── hashFile ─────────────────────────────────────────────────────────────────

describe('hashFile', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-hashfile-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('returns 64-char hex string for binary content', async () => {
    const filePath = path.join(tmpDir, 'test.bin');
    await fs.writeFile(filePath, Buffer.from([0x1f, 0x8b, 0x08, 0x00]));
    const result = await hashFile(filePath);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic for same content', async () => {
    const filePath = path.join(tmpDir, 'test.txt');
    await fs.writeFile(filePath, 'hello world');
    const a = await hashFile(filePath);
    const b = await hashFile(filePath);
    expect(a).toBe(b);
  });

  it('returns different hashes for different content', async () => {
    const fileA = path.join(tmpDir, 'a.txt');
    const fileB = path.join(tmpDir, 'b.txt');
    await fs.writeFile(fileA, 'hello');
    await fs.writeFile(fileB, 'world');
    const hashA = await hashFile(fileA);
    const hashB = await hashFile(fileB);
    expect(hashA).not.toBe(hashB);
  });

  it('hashes empty file', async () => {
    const filePath = path.join(tmpDir, 'empty.bin');
    await fs.writeFile(filePath, '');
    const result = await hashFile(filePath);
    expect(result).toMatch(/^[0-9a-f]{64}$/);
    // Known SHA-256 of empty input
    expect(result).toBe('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  });
});

// ─── verifyTarballChecksum ────────────────────────────────────────────────────

async function writeChecksumsFile(
  dir: string,
  entries: Array<{ filename: string; hash: string }>,
): Promise<string> {
  const filePath = path.join(dir, 'checksums.sha256');
  const content = entries.map((e) => `${e.hash}  ${e.filename}`).join('\n') + '\n';
  await fs.writeFile(filePath, content);
  return filePath;
}

describe('verifyTarballChecksum', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-verify-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  // ─── HAPPY ──────────────────────────────────────────────────

  it('passes when tarball hash matches checksums file (text format)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'release content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: 'flowguard-core-1.2.0.tgz', hash: actualHash },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  it('passes when tarball hash matches checksums file (binary marker format)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'release content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, `${actualHash} *flowguard-core-1.2.0.tgz\n`);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  it('matches tarball by basename regardless of path prefix in checksums file', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'release content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: `./${path.basename(tarballPath)}`, hash: actualHash },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  // ─── BAD ────────────────────────────────────────────────────

  it('fails when tarball content is tampered (hash mismatch)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'original content');
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    const wrongHash = '0'.repeat(64);
    await fs.writeFile(checksumsPath, `${wrongHash}  flowguard-core-1.2.0.tgz\n`);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow(
      'SHA-256 mismatch',
    );
  });

  it('fails when tarball not listed in checksums file', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: 'other-package.tgz', hash: '0'.repeat(64) },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('fails when checksums file has duplicate filename entries', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(
      checksumsPath,
      `${actualHash}  flowguard-core-1.2.0.tgz\n${actualHash}  flowguard-core-1.2.0.tgz\n`,
    );
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow(
      'Duplicate entry',
    );
  });

  it('fails when checksums file does not exist', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = path.join(tmpDir, 'nonexistent.sha256');
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow(
      'Cannot read checksums file',
    );
  });

  // ─── CORNER ─────────────────────────────────────────────────

  it('ignores malformed hash lines (not 64 hex chars)', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(
      checksumsPath,
      `short  flowguard-core-1.2.0.tgz\n${actualHash}  flowguard-core-1.2.0.tgz\n`,
    );
    // Two entries with same filename: one malformed (ignored), one valid (accepted)
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });

  it('substring match does not falsely match', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const checksumsPath = await writeChecksumsFile(tmpDir, [
      { filename: 'flowguard-core.tgz', hash: actualHash },
    ]);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('empty checksums file fails', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, '');
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('whitespace-only checksums file fails', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, '  \n  \n  ');
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).rejects.toThrow('not found');
  });

  it('case-insensitive hash comparison', async () => {
    const tarballPath = path.join(tmpDir, 'flowguard-core-1.2.0.tgz');
    await fs.writeFile(tarballPath, 'content');
    const actualHash = await hashFile(tarballPath);
    const upperHash = actualHash.toUpperCase();
    const checksumsPath = path.join(tmpDir, 'checksums.sha256');
    await fs.writeFile(checksumsPath, `${upperHash}  flowguard-core-1.2.0.tgz\n`);
    await expect(verifyTarballChecksum(tarballPath, checksumsPath)).resolves.toBeUndefined();
  });
});
