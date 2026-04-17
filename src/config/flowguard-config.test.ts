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

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { FlowGuardConfigSchema, DEFAULT_CONFIG, type FlowGuardConfig } from './flowguard-config';
import {
  readConfig,
  writeDefaultConfig,
  configPath,
  PersistenceError,
} from '../adapters/persistence';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy';

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

/** Write a raw string to the config file location. */
async function writeRawConfig(worktree: string, content: string): Promise<void> {
  await fs.mkdir(worktree, { recursive: true });
  await fs.writeFile(configPath(worktree), content, 'utf-8');
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
      expect(result.data.identity.allowedIssuers).toEqual([]);
      expect(result.data.identity.assertionMaxAgeSeconds).toBe(300);
      expect(result.data.identity.requireSessionBinding).toBe(true);
      expect(result.data.identity.allowLocalFallbackModes).toEqual(['solo', 'team']);
      expect(result.data.rbac.roleBindings).toEqual([]);
      expect(result.data.rbac.approvalConstraints.dualControlRequiredModes).toEqual(['regulated']);
      expect(result.data.rbac.approvalConstraints.requiredApproverRolesByMode).toEqual({
        regulated: ['approver', 'policy_owner'],
      });
      expect(result.data.risk.rules).toEqual([]);
      expect(result.data.risk.noMatchDecision).toBe('deny');
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
      },
      profile: {
        defaultId: 'typescript',
        activeChecks: ['test_quality', 'rollback_safety', 'type_coverage'],
      },
      identity: {
        allowedIssuers: ['https://idp.example.com'],
        assertionMaxAgeSeconds: 120,
        requireSessionBinding: true,
        allowLocalFallbackModes: ['solo'],
      },
      rbac: {
        roleBindings: [
          {
            subjectMatcher: { email: 'alice@example.com' },
            roles: ['approver'],
            conditions: { identitySource: ['oidc'], minAssuranceLevel: 'strong' },
          },
        ],
        approvalConstraints: {
          dualControlRequiredModes: ['regulated', 'team'],
          requiredApproverRolesByMode: {
            regulated: ['approver'],
            team: ['approver', 'policy_owner'],
          },
        },
      },
      risk: {
        rules: [
          {
            id: 'rule-prod-restricted',
            priority: 10,
            match: {
              actionType: ['review_decision'],
              dataClassification: ['restricted'],
              targetEnvironment: ['prod'],
              changeWindow: ['business_hours'],
              exceptionPolicy: ['approved_exception_only'],
            },
            effect: 'allow_with_approval',
            obligations: {
              ticketRequired: true,
              minAssuranceLevel: 'strong',
            },
          },
        ],
        noMatchDecision: 'deny',
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
      expect(result.data.profile.defaultId).toBe('typescript');
      expect(result.data.identity.allowedIssuers).toEqual(['https://idp.example.com']);
      expect(result.data.rbac.roleBindings).toHaveLength(1);
      expect(result.data.rbac.approvalConstraints.dualControlRequiredModes).toEqual([
        'regulated',
        'team',
      ]);
      expect(result.data.risk.rules).toHaveLength(1);
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

  it('rejects invalid assertionMaxAgeSeconds (0)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      identity: { assertionMaxAgeSeconds: 0 },
    });
    expect(result.success).toBe(false);
  });

  it('rejects role binding with empty subjectMatcher', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      rbac: { roleBindings: [{ subjectMatcher: {}, roles: ['approver'] }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid requiredApproverRolesByMode role value', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      rbac: {
        approvalConstraints: {
          requiredApproverRolesByMode: {
            regulated: ['chief_approver'],
          },
        },
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects invalid risk noMatchDecision', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      risk: { noMatchDecision: 'allow' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects non deny-default noMatchDecision (defer_to_mode)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      risk: { noMatchDecision: 'defer_to_mode' },
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

  it('accepts all policy modes for local fallback override', () => {
    for (const mode of ['solo', 'team', 'team-ci', 'regulated']) {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        identity: { allowLocalFallbackModes: [mode] },
      });
      expect(result.success).toBe(true);
    }
  });

  it('accepts all risk effects', () => {
    for (const effect of ['allow', 'allow_with_approval', 'deny']) {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        risk: {
          rules: [
            {
              id: 'r1',
              priority: 1,
              match: {},
              effect,
            },
          ],
        },
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

  it('rejects unknown properties (strict contract behavior)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      unknownField: 'should be stripped',
      logging: { level: 'warn', extra: true },
    });
    expect(result.success).toBe(false);
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
    expect(DEFAULT_CONFIG.identity).toBeDefined();
    expect(DEFAULT_CONFIG.rbac).toBeDefined();
    expect(DEFAULT_CONFIG.risk).toBeDefined();
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

describe('configPath', () => {
  it('resolves to config.json under workspace directory', () => {
    const p = configPath('/some/project');
    expect(p).toBe(path.join('/some/project', 'config.json'));
  });
});

// =============================================================================
// readConfig
// =============================================================================

describe('readConfig', () => {
  beforeEach(async () => {
    tmpDir = await createTmpWorktree();
  });

  afterEach(async () => {
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
      identity: {
        allowedIssuers: ['https://idp.example.com'],
        assertionMaxAgeSeconds: 300,
        requireSessionBinding: true,
        allowLocalFallbackModes: ['solo', 'team'],
      },
      rbac: {
        roleBindings: [],
        approvalConstraints: {
          dualControlRequiredModes: ['regulated'],
          requiredApproverRolesByMode: { regulated: ['approver', 'policy_owner'] },
        },
      },
      risk: { rules: [], noMatchDecision: 'deny' },
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

describe('writeDefaultConfig', () => {
  beforeEach(async () => {
    tmpDir = await createTmpWorktree();
  });

  afterEach(async () => {
    await cleanTmpDir(tmpDir);
  });

  // ── HAPPY ──────────────────────────────────────────────────────────────

  it('creates a config file that round-trips through readConfig', async () => {
    await writeDefaultConfig(tmpDir);
    const config = await readConfig(tmpDir);
    expect(config).toEqual(DEFAULT_CONFIG);
  });

  it('creates the workspace directory if missing', async () => {
    await writeDefaultConfig(tmpDir);
    const stat = await fs.stat(tmpDir);
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
    await writeDefaultConfig(tmpDir);
    const config = await readConfig(tmpDir);
    expect(config.logging.level).toBe('info'); // back to default
  });

  // ── CORNER ─────────────────────────────────────────────────────────────

  it('written file is pretty-printed JSON with trailing newline', async () => {
    await writeDefaultConfig(tmpDir);
    const raw = await fs.readFile(configPath(tmpDir), 'utf-8');
    expect(raw.endsWith('\n')).toBe(true);
    // Pretty-printed = contains newlines within the JSON
    expect(raw.split('\n').length).toBeGreaterThan(2);
  });

  it('written file content is valid JSON', async () => {
    await writeDefaultConfig(tmpDir);
    const raw = await fs.readFile(configPath(tmpDir), 'utf-8');
    expect(() => JSON.parse(raw)).not.toThrow();
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
