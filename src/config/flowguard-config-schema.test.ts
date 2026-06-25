/**
 * @module config/flowguard-config-schema.test
 * @description Tests for FlowGuardConfigSchema and DEFAULT_CONFIG.
 *              Pure in-memory — no filesystem, no readConfig.
 *
 * Covers:
 * - Schema: parsing, defaults, validation, rejection of invalid inputs
 * - DEFAULT_CONFIG: normalization and round-trip
 * - PERF: schema parse speed benchmark
 *
 * Config I/O, precedence, and path resolution tests live in
 * flowguard-config-io.test.ts.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect } from 'vitest';
import { FlowGuardConfigSchema, DEFAULT_CONFIG, type FlowGuardConfig } from './flowguard-config.js';
import { benchmarkSync, PERF_BUDGETS } from '../test-policy.js';

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
      expect(result.data.host).toEqual({});
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
      host: {
        defaultHost: 'claude-code',
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
      expect(result.data.host.defaultHost).toBe('claude-code');
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
      // host defaults to empty object; runtime defaults are resolved by CLI host-resolver
      expect(result.data.host.defaultHost).toBeUndefined();
    }
  });

  it('accepts supported host defaults', () => {
    for (const host of ['opencode', 'claude-code', 'codex'] as const) {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        host: { defaultHost: host },
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.host.defaultHost).toBe(host);
      }
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

  it('rejects invalid host default', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      host: { defaultHost: 'unknown-host' },
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

  describe('logging.consoleFormat', () => {
    it('defaults to text', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
      });
      expect(result.success).toBe(true);
      expect(result.data!.logging.consoleFormat).toBe('text');
    });

    it('accepts json', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { consoleFormat: 'json' },
      });
      expect(result.success).toBe(true);
      expect(result.data!.logging.consoleFormat).toBe('json');
    });

    it('rejects invalid format', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { consoleFormat: 'xml' },
      });
      expect(result.success).toBe(false);
    });
  });

  describe('logging.maxFileSizeMb', () => {
    it('defaults to 10', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
      });
      expect(result.success).toBe(true);
      expect(result.data!.logging.maxFileSizeMb).toBe(10);
    });

    it('accepts custom value', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { maxFileSizeMb: 50 },
      });
      expect(result.success).toBe(true);
      expect(result.data!.logging.maxFileSizeMb).toBe(50);
    });

    it('rejects below minimum (1)', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { maxFileSizeMb: 0 },
      });
      expect(result.success).toBe(false);
    });

    it('rejects above maximum (1024)', () => {
      const result = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { maxFileSizeMb: 1025 },
      });
      expect(result.success).toBe(false);
    });

    it('accepts boundary values 1 and 1024', () => {
      const min = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { maxFileSizeMb: 1 },
      });
      expect(min.success).toBe(true);

      const max = FlowGuardConfigSchema.safeParse({
        schemaVersion: 'v1',
        logging: { maxFileSizeMb: 1024 },
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

  it('accepts a valid validationEvidence policy block (#400)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: {
        validationEvidence: { enforcement: 'required', allowNoCommands: true },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy.validationEvidence).toEqual({
        enforcement: 'required',
        allowNoCommands: true,
      });
    }
  });

  it('accepts a partial validationEvidence block (enforcement only) (#400)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { validationEvidence: { enforcement: 'advisory' } },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.policy.validationEvidence).toEqual({ enforcement: 'advisory' });
    }
  });

  it('rejects an invalid validationEvidence enforcement value (#400)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { validationEvidence: { enforcement: 'mandatory' } },
    });
    expect(result.success).toBe(false);
  });

  it('rejects a non-boolean validationEvidence.allowNoCommands (#400)', () => {
    const result = FlowGuardConfigSchema.safeParse({
      schemaVersion: 'v1',
      policy: { validationEvidence: { allowNoCommands: 'yes' } },
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

// ══════════════════════════════════════════════════
// Performance
// ══════════════════════════════════════════════════

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
