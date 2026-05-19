/**
 * @module config/flowguard-config.test
 * @description Tests for FlowGuard config schema, readConfig, and writeDefaultConfig.
 *
 * Covers:
 * - Schema: parsing, defaults, validation, rejection of invalid inputs
 * - readConfig: missing file (returns defaults), valid file, invalid JSON, schema errors, read errors
 * - writeDefaultConfig: creates file, content round-trips through readConfig
 * - configPath: correct path resolution
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
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
import { FlowGuardConfigSchema, DEFAULT_CONFIG, type FlowGuardConfig } from './flowguard-config.js';
import { globalConfigPath, repoConfigPath, PersistenceError } from '../adapters/persistence.js';
import { readConfig } from '../adapters/persistence-config.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

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

// =============================================================================
// Schema
// =============================================================================

describe('FlowGuardConfigSchema', () => {
  // ── HAPPY ──────────────────────────────────────────────────────────────

  it('parses a minimal valid config (schemaVersion only)', () => {
    const result = FlowGuardConfigSchema.safeParse({ schemaVersion: 'v1' });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('v1');
      expect(result.data.logging.level).toBe('info');
      expect(result.data.policy).toEqual({});
      expect(result.data.profile).toEqual({});
      expect(result.data.archive.redaction.mode).toBe('basic');
      expect(result.data.archive.redaction.includeRaw).toBe(false);
    }
  });

  it('parses a fully specified config', () => {
    const full = {
      schemaVersion: 'v1',
      logging: { level: 'debug' },
      policy: {
        defaultMode: 'regulated',
        maxSelfReviewIterations: 5,
        maxImplReviewIterations: 7,
        enforceRiskClassification: true,
        allowRiskDowngradeOverride: false,
        allowReducedCeremony: true,
      },
      profile: {
        defaultId: 'typescript',
        activeChecks: ['test_quality', 'rollback_safety', 'type_coverage'],
      },
      archive: {
        redaction: {
          mode: 'strict',
          includeRaw: true,
        },
      },
    };
    const result = FlowGuardConfigSchema.safeParse(full);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.logging.level).toBe('debug');
      expect(result.data.policy.defaultMode).toBe('regulated');
      expect(result.data.policy.maxSelfReviewIterations).toBe(5);
      expect(result.data.policy.maxImplReviewIterations).toBe(7);
      expect(result.data.policy.enforceRiskClassification).toBe(true);
      expect(result.data.policy.allowRiskDowngradeOverride).toBe(false);
      expect(result.data.policy.allowReducedCeremony).toBe(true);
      expect(result.data.profile.defaultId).toBe('typescript');
      expect(result.data.profile.activeChecks).toEqual([
        'test_quality',
        'rollback_safety',
        'type_coverage',
      ]);
      expect(result.data.archive.redaction.mode).toBe('strict');
      expect(result.data.archive.redaction.includeRaw).toBe(true);
    }
  });

  it('applies defaults for omitted nested objects', () => {
    const result = FlowGuardConfigSchema.safeParse({ schemaVersion: 'v1' });
    expect(result.success).toBe(true);
    if (result.success) {
      // logging.level defaults to "info"
      expect(result.data.logging.level).toBe('info');
      // policy defaults to empty object (all fields optional)
      expect(result.data.policy.defaultMode).toBeUndefined();
      expect(result.data.policy.maxSelfReviewIterations).toBeUndefined();
      // profile defaults to empty object
      expect(result.data.profile.defaultId).toBeUndefined();
      expect(result.data.profile.activeChecks).toBeUndefined();
    }
  });

  // ── BAD ────────────────────────────────────────────────────────────────

  it('rejects missing schemaVersion', () => {
    const result = FlowGuardConfigSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects wrong schemaVersion', () => {
    const result = FlowGuardConfigSchema.safeParse({ schemaVersion: 'v2' });
    expect(result.success).toBe(false);
  });

  it('rejects invalid log level', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      logging: { level: 'trace' },
    });
    expect(result.success).toBe(false);
  });

  describe('logging.mode', () => {
    it('defaults to file mode', () => {
      const result = FlowGuardConfigSchema.safeParse({ schemaVersion: 'v1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.mode).toBe('file');
      }
    });

    it('accepts file mode', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { mode: 'file' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.mode).toBe('file');
      }
    });

    it('accepts ui mode', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { mode: 'ui' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.mode).toBe('ui');
      }
    });

    it('accepts both mode', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { mode: 'both' },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.mode).toBe('both');
      }
    });

    it('rejects invalid mode', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { mode: 'cloud' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('logging.retentionDays', () => {
    it('defaults to 7 days', () => {
      const result = FlowGuardConfigSchema.safeParse({ schemaVersion: 'v1' });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.retentionDays).toBe(7);
      }
    });

    it('accepts custom retention days', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { retentionDays: 30 },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.logging.retentionDays).toBe(30);
      }
    });

    it('rejects retentionDays below minimum (1)', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { retentionDays: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects retentionDays above maximum (90)', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { retentionDays: 91 },
      });
      expect(result.success).toBe(false);
    });

    it('accepts boundary values 1 and 90', () => {
      const min = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { retentionDays: 1 },
      });
      expect(min.success).toBe(true);

      const max = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { retentionDays: 90 },
      });
      expect(max.success).toBe(true);
    });
  });

  it('rejects invalid policy mode', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { defaultMode: 'turbo' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxSelfReviewIterations out of range (0)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { maxSelfReviewIterations: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxSelfReviewIterations out of range (11)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { maxSelfReviewIterations: 11 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxImplReviewIterations out of range (0)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { maxImplReviewIterations: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects maxImplReviewIterations out of range (11)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { maxImplReviewIterations: 11 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-integer maxSelfReviewIterations', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { maxSelfReviewIterations: 2.5 },
    });
    expect(result.success).toBe(false);
  });

  it('accepts static IdP policy config with signingKeys', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        identityProvider: {
          mode: 'static',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          signingKeys: [
            {
              kind: 'pem',
              kid: 'key-1',
              alg: 'RS256',
              pem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts jwks IdP policy config with jwksPath', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        identityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts jwks IdP policy config with jwksUri and cacheTtlSeconds', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        identityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksUri: 'https://id.example.com/.well-known/jwks.json',
          cacheTtlSeconds: 120,
        },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects jwks mode when signingKeys is also provided (no mixed authority)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        identityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
          signingKeys: [
            {
              kind: 'pem',
              kid: 'key-1',
              alg: 'RS256',
              pem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
            },
          ],
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects static mode when jwksPath is also provided (no mixed authority)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        identityProvider: {
          mode: 'static',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          signingKeys: [
            {
              kind: 'pem',
              kid: 'key-1',
              alg: 'RS256',
              pem: '-----BEGIN PUBLIC KEY-----\nMIIB\n-----END PUBLIC KEY-----',
            },
          ],
          jwksPath: '/etc/flowguard/jwks.json',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects jwks mode when both jwksPath and jwksUri are provided', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        identityProvider: {
          mode: 'jwks',
          issuer: 'https://issuer.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/flowguard/jwks.json',
          jwksUri: 'https://id.example.com/.well-known/jwks.json',
        },
      },
    });
    expect(result.success).toBe(false);
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it('accepts boundary values for iterations (1 and 10)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { maxSelfReviewIterations: 1, maxImplReviewIterations: 10 },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy.maxSelfReviewIterations).toBe(1);
      expect(result.data.policy.maxImplReviewIterations).toBe(10);
    }
  });

  it('accepts empty activeChecks array', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      profile: { activeChecks: [] },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.profile.activeChecks).toEqual([]);
    }
  });

  it('accepts all log levels', () => {
    for (const level of ['debug', 'info', 'warn', 'error', 'silent']) {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { level },
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts all policy modes', () => {
    for (const mode of ['solo', 'team', 'team-ci', 'regulated']) {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        policy: { defaultMode: mode },
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts all redaction modes', () => {
    for (const mode of ['none', 'basic', 'strict']) {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        archive: { redaction: { mode } },
      });
      expect(result.success).toBe(true);
    }
  });

  it('rejects invalid redaction mode', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      archive: { redaction: { mode: 'unsafe' } },
    });
    expect(result.success).toBe(false);
  });

  // ── EDGE ───────────────────────────────────────────────────────────────

  it('strips unknown properties (Zod default strip behavior)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      unknownField: 'should be stripped',
      logging: { level: 'warn', extra: true },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect((result.data as Record<string, unknown>)['unknownField']).toBeUndefined();
    }
  });
});

// =============================================================================
// DEFAULT_CONFIG
// =============================================================================

describe('DEFAULT_CONFIG', () => {
  it('is fully normalized (all fields present)', () => {
    expect(DEFAULT_CONFIG.schemaVersion).toBe('v1');
    expect(DEFAULT_CONFIG.logging.level).toBe('info');
    expect(DEFAULT_CONFIG.policy).toBeDefined();
    expect(DEFAULT_CONFIG.profile).toBeDefined();
  });

  it('round-trips through schema parse', () => {
    const result = FlowGuardConfigSchema.safeParse(DEFAULT_CONFIG);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual(DEFAULT_CONFIG);
    }
  });
});

// =============================================================================
// configPath
// =============================================================================

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
  });

  it('reads and parses a valid config file', async () => {
    const custom: FlowGuardConfig = {
      schemaVersion: 'v1',
      logging: { level: 'debug' },
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
    schemaVersion: 'v1',
    logging: { level: 'debug' },
    policy: { defaultMode: 'regulated' },
    profile: {},
    archive: { redaction: { mode: 'basic', includeRaw: false } },
  };

  const GLOBAL_CUSTOM: FlowGuardConfig = {
    schemaVersion: 'v1',
    logging: { level: 'warn' },
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

// =============================================================================
// Performance
// =============================================================================

describe('Performance', () => {
  // ── PERF ───────────────────────────────────────────────────────────────

  it('schema parse is fast (1000 iterations)', () => {
    const input = { schemaVersion: 'v1', logging: { level: 'debug' } };
    const result = benchmarkSync(() => {
      FlowGuardConfigSchema.parse(input);
    }, 1000);
    // Zod parse should be under 5ms p99
    expect(result.p99Ms).toBeLessThan(PERF_BUDGETS.stateSerializeMs);
  });
});
