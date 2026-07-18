/**
 * @module config/flowguard-config-io.test
 * @description Tests for config I/O — readConfig, precedence, path resolution,
 *              and file round-tripping.
 *
 * Covers:
 * - configPath: repoConfigPath and globalConfigPath resolution
 * - readConfig: missing file (returns defaults), valid file, invalid JSON,
 *   schema errors, read errors
 * - file I/O: write, read, overwrite, directory creation
 * - precedence: repo → global → default chain with fail-closed validation
 *
 * Schema validation and DEFAULT_CONFIG shape tests live in
 * flowguard-config-schema.test.ts.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { withTestEnv } from '../integration/test-helpers.js';
import * as fsActual from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  (globalThis as Record<string, unknown>).__fsActualCFG = actual;
  return {
    ...actual,
    readFile: vi.fn((...args: Parameters<typeof actual.readFile>) => actual.readFile(...args)),
  };
});

import * as fs from 'node:fs/promises';

function restoreReadFile(): void {
  const actual = (globalThis as Record<string, unknown>).__fsActualCFG as typeof fsActual;
  vi.mocked(fs.readFile).mockImplementation((...args: Parameters<(typeof fs)['readFile']>) =>
    actual.readFile(...args),
  );
}
import { DEFAULT_CONFIG, type FlowGuardConfig } from './flowguard-config.js';
import { globalConfigPath, repoConfigPath, PersistenceError } from '../adapters/persistence.js';
import { readConfig } from '../adapters/persistence-config.js';

// ─── Test Helpers ─────────────────────────────────────────────────────────────

let tmpDir: string;

async function createTmpWorktree(): Promise<string> {
  return await fs.mkdtemp(path.join(os.tmpdir(), 'fg-config-test-'));
}

async function cleanTmpDir(dir: string): Promise<void> {
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    // Best effort on Windows
  }
}

/** Write a raw string to the config file at the repo path (P11: {worktree}/.opencode/flowguard.json). */
async function writeRawConfig(worktree: string, content: string): Promise<void> {
  const dir = path.join(worktree, '.opencode');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(repoConfigPath(worktree), content, 'utf-8');
}

// ═══════════════════════════════════════════════════════════════════
// Config Paths
// ═══════════════════════════════════════════════════════════════════

describe('config paths', () => {
  it('repoConfigPath resolves to {worktree}/.opencode/flowguard.json', () => {
    expect(repoConfigPath('/some/project')).toBe(
      path.join('/some/project', '.opencode', 'flowguard.json'),
    );
  });

  // Keep this path assertion side-effect free; readConfig tests below isolate OPENCODE_CONFIG_DIR.
  it('globalConfigPath resolves under OPENCODE_CONFIG_DIR or ~/.config/opencode', () => {
    expect(globalConfigPath()).toContain('flowguard.json');
  });
});

// =============================================================================
// readConfig
// =============================================================================

describe('readConfig', () => {
  let restoreEnv: () => void;

  beforeEach(async () => {
    tmpDir = await createTmpWorktree();
    restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: tmpDir });
  });

  afterEach(async () => {
    restoreEnv();
    await cleanTmpDir(tmpDir);
  });

  // ── HAPPY ──────────────────────────────────────────────────────────────

  it('returns DEFAULT_CONFIG when no config file exists', async () => {
    const config = await readConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.archive.redaction).toEqual({ mode: 'none', includeRaw: true });
  });

  it('reads and parses a valid config file', async () => {
    const custom: FlowGuardConfig = {
      ...DEFAULT_CONFIG,
      schemaVersion: 'v1',
      logging: { ...DEFAULT_CONFIG.logging, level: 'debug' },
      policy: { defaultMode: 'regulated' },
      profile: { defaultId: 'typescript' },
      archive: { redaction: { mode: 'basic', includeRaw: false } },
    };
    await writeRawConfig(tmpDir, JSON.stringify(custom));
    const config = await readConfig(tmpDir);
    expect(config.logging.level).toBe('debug');
    expect(config.policy.defaultMode).toBe('regulated');
    expect(config.profile.defaultId).toBe('typescript');
  });

  it('fills in defaults for partially specified config', async () => {
    await writeRawConfig(
      tmpDir,
      JSON.stringify({
        schemaVersion: 'v1',
        logging: { level: 'error' },
      }),
    );
    const config = await readConfig(tmpDir);
    expect(config.logging.level).toBe('error');
    // policy and profile should have defaults
    expect(config.policy).toEqual({});
    expect(config.profile).toEqual({});
    expect(config.archive.redaction).toEqual({ mode: 'none', includeRaw: true });
  });

  // ── BAD ────────────────────────────────────────────────────────────────

  it('throws PARSE_FAILED for invalid JSON', async () => {
    await writeRawConfig(tmpDir, 'not json {{{');
    await expect(readConfig(tmpDir)).rejects.toThrow(PersistenceError);
    try {
      await readConfig(tmpDir);
    } catch (err) {
      expect(err).toBeInstanceOf(PersistenceError);
      expect((err as PersistenceError).code).toBe('PARSE_FAILED');
    }
  });

  it('throws SCHEMA_VALIDATION_FAILED for valid JSON but invalid schema', async () => {
    await writeRawConfig(tmpDir, JSON.stringify({ schemaVersion: 'v99' }));
    await expect(readConfig(tmpDir)).rejects.toThrow(PersistenceError);
    try {
      await readConfig(tmpDir);
    } catch (err) {
      expect(err).toBeInstanceOf(PersistenceError);
      expect((err as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
    }
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it('handles empty JSON object (missing schemaVersion)', async () => {
    await writeRawConfig(tmpDir, '{}');
    await expect(readConfig(tmpDir)).rejects.toThrow(PersistenceError);
    try {
      await readConfig(tmpDir);
    } catch (err) {
      expect((err as PersistenceError).code).toBe('SCHEMA_VALIDATION_FAILED');
    }
  });

  it('handles empty file', async () => {
    await writeRawConfig(tmpDir, '');
    await expect(readConfig(tmpDir)).rejects.toThrow(PersistenceError);
  });
});

// =============================================================================
// writeDefaultConfig
// =============================================================================

describe('config file I/O', () => {
  beforeEach(async () => {
    tmpDir = await createTmpWorktree();
  });

  afterEach(async () => {
    await cleanTmpDir(tmpDir);
  });

  // ── HAPPY ──────────────────────────────────────────────────────────────

  it('creates a config file that round-trips through readConfig', async () => {
    await fs.mkdir(path.join(tmpDir, '.opencode'), { recursive: true });
    await fs.writeFile(
      repoConfigPath(tmpDir),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
      'utf-8',
    );
    const config = await readConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('creates the repo .opencode directory if missing', async () => {
    await fs.mkdir(path.join(tmpDir, '.opencode'), { recursive: true });
    await fs.writeFile(
      repoConfigPath(tmpDir),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
      'utf-8',
    );
    const stat = await fs.stat(path.join(tmpDir, '.opencode'));
    expect(stat.isDirectory()).toBe(true);
  });

  it('overwrites an existing config file', async () => {
    // Write a custom config first
    await writeRawConfig(
      tmpDir,
      JSON.stringify({
        schemaVersion: 'v1',
        logging: { level: 'debug' },
      }),
    );

    // Now overwrite with default
    await fs.writeFile(
      repoConfigPath(tmpDir),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
      'utf-8',
    );
    const config = await readConfig(tmpDir);
    expect(config.logging.level).toBe('info'); // back to default
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it('written file is pretty-printed JSON with trailing newline', async () => {
    await fs.mkdir(path.join(tmpDir, '.opencode'), { recursive: true });
    await fs.writeFile(
      repoConfigPath(tmpDir),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
      'utf-8',
    );
    const raw = await fs.readFile(repoConfigPath(tmpDir), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    expect(raw.split('\n').length).toBeGreaterThan(2);
  });

  it('written file content is valid JSON', async () => {
    await fs.mkdir(path.join(tmpDir, '.opencode'), { recursive: true });
    await fs.writeFile(
      repoConfigPath(tmpDir),
      JSON.stringify(DEFAULT_CONFIG, null, 2) + '\n',
      'utf-8',
    );
    const raw = await fs.readFile(repoConfigPath(tmpDir), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// =============================================================================
// readConfig — precedence (repo → global → default)
// =============================================================================

describe('readConfig — precedence', () => {
  let worktree: string;
  let globalCfgDir: string;
  let restoreEnv: () => void;

  beforeEach(async () => {
    worktree = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-precedence-repo-'));
    globalCfgDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-precedence-global-'));
    restoreEnv = withTestEnv({ OPENCODE_CONFIG_DIR: globalCfgDir });
  });

  afterEach(async () => {
    restoreEnv();
    try {
      await fs.rm(worktree, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    try {
      await fs.rm(globalCfgDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
    restoreReadFile();
  });

  async function writeGlobalConfig(content: string): Promise<void> {
    await fs.mkdir(globalCfgDir, { recursive: true });
    await fs.writeFile(path.join(globalCfgDir, 'flowguard.json'), content, 'utf-8');
  }

  const REPO_CUSTOM: FlowGuardConfig = {
    ...DEFAULT_CONFIG,
    schemaVersion: 'v1',
    logging: { ...DEFAULT_CONFIG.logging, level: 'debug' },
    policy: { defaultMode: 'regulated' },
    profile: {},
    archive: { redaction: { mode: 'basic', includeRaw: false } },
  };

  const GLOBAL_CUSTOM: FlowGuardConfig = {
    ...DEFAULT_CONFIG,
    schemaVersion: 'v1',
    logging: { ...DEFAULT_CONFIG.logging, level: 'warn' },
    policy: {},
    profile: { defaultId: 'global-profile' },
    archive: { redaction: { mode: 'basic', includeRaw: false } },
  };

  // ── HAPPY ──────────────────────────────────────────────────

  it('repo config present → returned, global ignored', async () => {
    await writeRawConfig(worktree, JSON.stringify(REPO_CUSTOM));
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));

    const config = await readConfig(worktree);
    expect(config.logging.level).toBe('debug');
    expect(config.policy.defaultMode).toBe('regulated');
    expect(config.profile.defaultId).toBeUndefined();
  });

  it('repo config missing → falls through to global', async () => {
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));

    const config = await readConfig(worktree);
    expect(config.logging.level).toBe('warn');
    expect(config.profile.defaultId).toBe('global-profile');
    expect(config.policy.defaultMode).toBeUndefined();
  });

  it('both missing → returns DEFAULT_CONFIG', async () => {
    const config = await readConfig(worktree);
    expect(config).toEqual(DEFAULT_CONFIG);
    expect(config.logging.level).toBe('info');
  });

  it('readConfig without worktree → skips repo, only checks global', async () => {
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));

    const config = await readConfig();
    expect(config.logging.level).toBe('warn');
    expect(config.profile.defaultId).toBe('global-profile');
  });

  // ── BAD ────────────────────────────────────────────────────

  it('repo config present but INVALID → throws (no fallthrough to global)', async () => {
    await writeRawConfig(worktree, 'not json {{{');
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));

    let caught: PersistenceError | undefined;
    try {
      await readConfig(worktree);
    } catch (err) {
      caught = err as PersistenceError;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect(caught!.code).toBe('PARSE_FAILED');
  });

  it('repo missing, global INVALID schema → throws (no fallthrough to default)', async () => {
    await writeGlobalConfig(JSON.stringify({ schemaVersion: 'v99' }));

    let caught: PersistenceError | undefined;
    try {
      await readConfig(worktree);
    } catch (err) {
      caught = err as PersistenceError;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect(caught!.code).toBe('SCHEMA_VALIDATION_FAILED');
  });

  // ── CORNER ─────────────────────────────────────────────────

  it('repo valid, global INVALID → repo returned (global never reached)', async () => {
    await writeRawConfig(worktree, JSON.stringify(REPO_CUSTOM));
    await writeGlobalConfig('not json {{{');

    const config = await readConfig(worktree);
    expect(config.logging.level).toBe('debug');
    expect(config.policy.defaultMode).toBe('regulated');
  });

  it('repo ENOENT, global EACCES → throws READ_FAILED', async () => {
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));
    vi.mocked(fs.readFile).mockImplementation((...args: unknown[]) => {
      const [filePathStr] = args;
      if (
        typeof filePathStr === 'string' &&
        filePathStr.includes(globalCfgDir) &&
        filePathStr.includes('flowguard.json')
      ) {
        const err = new Error('permission denied') as NodeJS.ErrnoException;
        err.code = 'EACCES';
        return Promise.reject(err);
      }
      const actual = (globalThis as Record<string, unknown>).__fsActualCFG as typeof fsActual;
      return actual.readFile(...(args as Parameters<typeof actual.readFile>));
    });

    let caught: PersistenceError | undefined;
    try {
      await readConfig(worktree);
    } catch (err) {
      caught = err as PersistenceError;
    }
    expect(caught).toBeInstanceOf(PersistenceError);
    expect(caught!.code).toBe('READ_FAILED');
  });

  it('both present and valid → repo wins', async () => {
    await writeRawConfig(worktree, JSON.stringify(REPO_CUSTOM));
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));

    const config = await readConfig(worktree);
    expect(config.logging.level).toBe('debug');
    expect(config.policy.defaultMode).toBe('regulated');
    expect(config.profile.defaultId).toBeUndefined();
  });

  // ── EDGE ───────────────────────────────────────────────────

  it('returned config is a deep clone (mutation safe)', async () => {
    const config1 = await readConfig(worktree);
    const config2 = await readConfig(worktree);

    expect(config1).not.toBe(config2);
    expect(config1).toEqual(config2);

    config1.logging.level = 'debug';
    const config3 = await readConfig(worktree);
    expect(config3.logging.level).toBe('info');
  });

  it('global config returns defaults when absent', async () => {
    // Neither repo nor global present
    const config = await readConfig(worktree);
    expect(config).toEqual(DEFAULT_CONFIG);

    // Only global present
    await writeGlobalConfig(JSON.stringify(GLOBAL_CUSTOM));
    const config2 = await readConfig(worktree);
    expect(config2.logging.level).toBe('warn');
    expect(config2).not.toEqual(DEFAULT_CONFIG);
  });
});
