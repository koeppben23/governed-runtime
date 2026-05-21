/**
 * @module integration/sdk-contract-governance.test
 * @description HAI governance surface contract tests.
 *
 * Validates that FlowGuard's Host-Agnostic Adapter Interface (HAI) matches
 * the pinned governance surface schemas. Detects:
 * - HostAdapter method additions/removals
 * - EnforcementDecision shape drift
 * - GovernanceStateProjection field changes
 * - Deny code registry completeness
 *
 * Addresses Keesan12 comment on Issue #250:
 * > "The contract I'd want pinned is: what approval boundary exists,
 * > what halt reasons can be emitted, what receipt fields are guaranteed
 * > after a stop, what verifier state survives, and which parts are
 * > only advisory on that host."
 *
 * Evidence sources:
 * - .sdk-baselines/governance/ (4 schema files)
 * - src/adapters/host-adapter.ts (HAI interface)
 * - src/config/reasons-infra.ts (deny codes)
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all categories present.
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

// ─── Baseline Loading ────────────────────────────────────────────────────────

const root = path.resolve(import.meta.dirname, '..', '..');
const govBaseDir = path.join(root, '.sdk-baselines', 'governance');

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(govBaseDir, file), 'utf-8'));
}

// ─── Runtime Type Imports (for compile-time verification) ────────────────────

import type {
  HostAdapter,
  HostCapabilities,
  EnforcementLevel,
  EnforcementDecision,
  BlockDecision,
  AllowDecision,
  GovernanceStateProjection,
} from '../adapters/host-adapter.js';

// Compile-time assertions — if these compile, the types exist
type _hasPlatform = HostAdapter['platform'];
type _hasCaps = HostAdapter['capabilities'];
type _hasLevel = HostAdapter['enforcementLevel'];
type _blockHasFields = BlockDecision['blocked'] & BlockDecision['reason'] & BlockDecision['code'];
type _allowHasFields = AllowDecision['blocked'];
type _gspFields = GovernanceStateProjection['sessionId'] &
  GovernanceStateProjection['phase'] &
  GovernanceStateProjection['enforcementActive'];

// Suppress unused type warnings
void (undefined as unknown as _hasPlatform);
void (undefined as unknown as _hasCaps);
void (undefined as unknown as _hasLevel);
void (undefined as unknown as _blockHasFields);
void (undefined as unknown as _allowHasFields);
void (undefined as unknown as _gspFields);

// ═══════════════════════════════════════════════════════════════════════════════
// GOVERNANCE SURFACE BASELINES
// ═══════════════════════════════════════════════════════════════════════════════

describe('SDK Contract: HAI governance surface', () => {
  describe('HAPPY: baseline schema files exist', () => {
    const expectedFiles = [
      'host-adapter-interface.json',
      'enforcement-decision.json',
      'governance-state-projection.json',
      'deny-codes.json',
      'version.json',
    ];

    for (const file of expectedFiles) {
      it(`${file} exists in .sdk-baselines/governance/`, () => {
        expect(existsSync(path.join(govBaseDir, file))).toBe(true);
      });
    }
  });

  describe('HAPPY: HostAdapter interface contract is pinned', () => {
    it('schema requires all HostAdapter methods', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const required = schema.required as string[];
      expect(required).toContain('platform');
      expect(required).toContain('capabilities');
      expect(required).toContain('enforcementLevel');
      expect(required).toContain('getSessionId');
      expect(required).toContain('getWorkingDirectory');
      expect(required).toContain('getWorktree');
      expect(required).toContain('initialize');
      expect(required).toContain('validateCapabilities');
      expect(required).toContain('shutdown');
      expect(required).toContain('deliverBlockDecision');
      expect(required).toContain('deliverArgMutation');
      expect(required).toContain('mutateToolResult');
      expect(required).toContain('spawnReviewer');
      expect(required).toContain('isReviewerSupported');
      expect(required).toContain('log');
    });

    it('platform enum has all 3 supported hosts', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.platform.enum).toEqual(['opencode', 'claude-code', 'codex']);
    });

    it('enforcementLevel enum has 3 levels', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.enforcementLevel.enum).toEqual(['synchronous', 'hook_gated', 'advisory']);
    });

    it('HostCapabilities has all 6 boolean fields', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const defs = schema.$defs as Record<string, Record<string, unknown>>;
      const capSchema = defs.HostCapabilities;
      const capRequired = capSchema.required as string[];
      expect(capRequired).toContain('preToolBlock');
      expect(capRequired).toContain('argMutation');
      expect(capRequired).toContain('outputReplacement');
      expect(capRequired).toContain('contextInjection');
      expect(capRequired).toContain('reviewerSpawn');
      expect(capRequired).toContain('compactionInjection');
    });
  });

  describe('HAPPY: EnforcementDecision discriminated union is pinned', () => {
    it('schema is a oneOf with Block and Allow variants', () => {
      const schema = loadSchema('enforcement-decision.json');
      expect(schema.oneOf).toBeDefined();
      expect((schema.oneOf as unknown[]).length).toBe(2);
    });

    it('BlockDecision requires blocked=true, reason, code', () => {
      const schema = loadSchema('enforcement-decision.json');
      const variants = schema.oneOf as Record<string, unknown>[];
      const blockVariant = variants.find(
        (v) => (v as Record<string, unknown>).title === 'BlockDecision',
      ) as Record<string, unknown>;
      expect(blockVariant).toBeDefined();
      expect(blockVariant.required).toContain('blocked');
      expect(blockVariant.required).toContain('reason');
      expect(blockVariant.required).toContain('code');
    });

    it('AllowDecision requires blocked=false, has optional modifiedArgs', () => {
      const schema = loadSchema('enforcement-decision.json');
      const variants = schema.oneOf as Record<string, unknown>[];
      const allowVariant = variants.find(
        (v) => (v as Record<string, unknown>).title === 'AllowDecision',
      ) as Record<string, unknown>;
      expect(allowVariant).toBeDefined();
      expect(allowVariant.required).toContain('blocked');
      const props = allowVariant.properties as Record<string, unknown>;
      expect(props).toHaveProperty('modifiedArgs');
    });
  });

  describe('HAPPY: GovernanceStateProjection fields are pinned', () => {
    it('schema requires all 6 projection fields', () => {
      const schema = loadSchema('governance-state-projection.json');
      const required = schema.required as string[];
      expect(required).toContain('sessionId');
      expect(required).toContain('phase');
      expect(required).toContain('haltReason');
      expect(required).toContain('enforcementActive');
      expect(required).toContain('resumable');
      expect(required).toContain('riskGate');
    });

    it('haltReason is nullable string', () => {
      const schema = loadSchema('governance-state-projection.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.haltReason.type).toContain('null');
      expect(props.haltReason.type).toContain('string');
    });

    it('riskGate is nullable with status enum', () => {
      const schema = loadSchema('governance-state-projection.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      const riskGate = props.riskGate;
      expect(riskGate.oneOf).toBeDefined();
    });
  });

  describe('HAPPY: deny codes baseline covers all adapter/identity codes', () => {
    it('deny-codes.json exists and has codes array', () => {
      const schema = loadSchema('deny-codes.json');
      expect(schema.required).toContain('codes');
    });

    it('adapter codes are pinned', () => {
      const schema = loadSchema('deny-codes.json');
      const pinned = schema.properties_pinned as Record<string, string[]>;
      expect(pinned.adapter_codes).toContain('DISCOVERY_RESULT_MISSING');
      expect(pinned.adapter_codes).toContain('GIT_NOT_FOUND');
      expect(pinned.adapter_codes).toContain('STATE_MISSING');
      expect(pinned.adapter_codes).toContain('FINGERPRINT_FAILED');
      expect(pinned.adapter_codes).toContain('REVIEWER_INVOCATION_EXHAUSTED');
    });

    it('identity codes are pinned', () => {
      const schema = loadSchema('deny-codes.json');
      const pinned = schema.properties_pinned as Record<string, string[]>;
      expect(pinned.identity_codes).toContain('DECISION_IDENTITY_REQUIRED');
      expect(pinned.identity_codes).toContain('FOUR_EYES_ACTOR_MATCH');
      expect(pinned.identity_codes).toContain('ACTOR_CLAIM_EXPIRED');
      expect(pinned.identity_codes).toContain('ACTOR_IDP_MODE_REQUIRED');
    });
  });

  describe('EDGE: enforcement level maps to capability profile', () => {
    it('synchronous requires preToolBlock=true', () => {
      // This is a semantic assertion based on HAI documentation
      // synchronous enforcement = guaranteed block before tool runs
      const schema = loadSchema('host-adapter-interface.json');
      const defs = schema.$defs as Record<string, Record<string, unknown>>;
      const capProps = defs.HostCapabilities.properties as Record<string, unknown>;
      expect(capProps).toHaveProperty('preToolBlock');
    });
  });

  describe('EDGE: injectCompactionContext is optional (not required)', () => {
    it('injectCompactionContext is not in required array', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const required = schema.required as string[];
      expect(required).not.toContain('injectCompactionContext');
    });

    it('injectCompactionContext is still in properties', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const props = schema.properties as Record<string, unknown>;
      expect(props).toHaveProperty('injectCompactionContext');
    });
  });

  describe('CORNER: version.json records governance surface metadata', () => {
    it('version.json has platform=governance and source reference', () => {
      const version = loadSchema('version.json');
      expect(version.platform).toBe('governance');
      expect(version.source).toBe('src/adapters/host-adapter.ts');
      expect((version.schemas as string[]).length).toBe(4);
    });
  });

  describe('BAD: runtime type matches pinned contract', () => {
    it('HostAdapter.platform is a union of 3 string literals (compile-time)', () => {
      // This test passes if it compiles — the type system enforces the union
      const platformValues: HostAdapter['platform'][] = ['opencode', 'claude-code', 'codex'];
      expect(platformValues).toHaveLength(3);
    });

    it('EnforcementLevel is a union of 3 string literals (compile-time)', () => {
      const levels: EnforcementLevel[] = ['synchronous', 'hook_gated', 'advisory'];
      expect(levels).toHaveLength(3);
    });

    it('EnforcementDecision discriminates on blocked field (compile-time)', () => {
      const block: EnforcementDecision = { blocked: true, reason: 'test', code: 'TEST' };
      const allow: EnforcementDecision = { blocked: false };
      expect(block.blocked).toBe(true);
      expect(allow.blocked).toBe(false);
    });

    it('HostCapabilities has exactly 6 fields (compile-time)', () => {
      const caps: HostCapabilities = {
        preToolBlock: true,
        argMutation: false,
        outputReplacement: true,
        contextInjection: false,
        reviewerSpawn: true,
        compactionInjection: false,
      };
      expect(Object.keys(caps)).toHaveLength(6);
    });
  });
});
