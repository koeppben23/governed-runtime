/**
 * @module integration/sdk-contract-governance.test
 * @description HAI governance surface contract tests.
 *
 * Validates that FlowGuard's Host-Agnostic Adapter Interface (HAI) matches
 * the pinned governance surface schemas, including non-composable review
 * transport capabilities.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const govBaseDir = path.join(root, '.sdk-baselines', 'governance');

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(govBaseDir, file), 'utf-8'));
}

import type {
  HostAdapter,
  HostCapabilities,
  HostReviewTransportCapability,
  EnforcementLevel,
  EnforcementDecision,
  BlockDecision,
  AllowDecision,
  GovernanceStateProjection,
} from '../adapters/host-adapter.js';

type _hasPlatform = HostAdapter['platform'];
type _hasCaps = HostAdapter['capabilities'];
type _hasLevel = HostAdapter['enforcementLevel'];
type _blockHasFields = BlockDecision['blocked'] & BlockDecision['reason'] & BlockDecision['code'];
type _allowHasFields = AllowDecision['blocked'];
type _gspFields = GovernanceStateProjection['sessionId'] &
  GovernanceStateProjection['phase'] &
  GovernanceStateProjection['enforcementActive'];

void (undefined as unknown as _hasPlatform);
void (undefined as unknown as _hasCaps);
void (undefined as unknown as _hasLevel);
void (undefined as unknown as _blockHasFields);
void (undefined as unknown as _allowHasFields);
void (undefined as unknown as _gspFields);

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
      for (const field of [
        'platform',
        'capabilities',
        'enforcementLevel',
        'getWorkingDirectory',
        'getWorktree',
        'initialize',
        'validateCapabilities',
        'shutdown',
        'deliverBlockDecision',
        'deliverArgMutation',
        'mutateToolResult',
        'spawnReviewer',
        'isReviewerSupported',
        'log',
      ]) {
        expect(required).toContain(field);
      }
    });

    it('platform and enforcement enums are pinned', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.platform!.enum).toEqual(['opencode', 'claude-code', 'codex']);
      expect(props.enforcementLevel!.enum).toEqual(['synchronous', 'hook_gated', 'advisory']);
    });

    it('HostCapabilities owns one reviewTransports collection, not synthetic review booleans', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const defs = schema.$defs as Record<string, Record<string, unknown>>;
      const capSchema = defs.HostCapabilities!;
      const required = capSchema.required as string[];
      expect(required).toEqual([
        'preToolBlock',
        'argMutation',
        'outputReplacement',
        'contextInjection',
        'reviewTransports',
        'compactionInjection',
      ]);
      const props = capSchema.properties as Record<string, unknown>;
      expect(props).not.toHaveProperty('reviewerSpawn');
      expect(props).not.toHaveProperty('independentStructuredReview');
    });

    it('review transport schema pins visibility and structured authority on the same object', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const defs = schema.$defs as Record<string, Record<string, unknown>>;
      const transport = defs.HostReviewTransportCapability!;
      expect(transport.required).toEqual([
        'kind',
        'structuredOutput',
        'parentVisible',
        'transcriptNavigable',
        'isolatedAgentIdentity',
        'permissionIsolation',
        'assurance',
      ]);
      const props = transport.properties as Record<string, Record<string, unknown>>;
      expect(props.kind!.enum).toEqual(['native_task_structured_followup']);
      expect(props.structuredOutput!.const).toBe(true);
      expect(props.parentVisible!.const).toBe(true);
      expect(props.transcriptNavigable!.const).toBe(true);
      expect(props.isolatedAgentIdentity!.const).toBe(true);
      expect(props.permissionIsolation!.const).toBe(true);
      expect(props.assurance!.const).toBe('structured_high');
    });
  });

  describe('HAPPY: EnforcementDecision discriminated union is pinned', () => {
    it('schema is a oneOf with Block and Allow variants', () => {
      const schema = loadSchema('enforcement-decision.json');
      expect((schema.oneOf as unknown[]).length).toBe(2);
    });

    it('BlockDecision requires blocked=true, reason, code', () => {
      const schema = loadSchema('enforcement-decision.json');
      const variants = schema.oneOf as Record<string, unknown>[];
      const blockVariant = variants.find((v) => v.title === 'BlockDecision')!;
      expect(blockVariant.required).toContain('blocked');
      expect(blockVariant.required).toContain('reason');
      expect(blockVariant.required).toContain('code');
    });

    it('AllowDecision exposes optional modifiedArgs', () => {
      const schema = loadSchema('enforcement-decision.json');
      const variants = schema.oneOf as Record<string, unknown>[];
      const allowVariant = variants.find((v) => v.title === 'AllowDecision')!;
      expect(allowVariant.required).toContain('blocked');
      expect(allowVariant.properties).toHaveProperty('modifiedArgs');
    });
  });

  describe('HAPPY: GovernanceStateProjection fields are pinned', () => {
    it('schema requires all six projection fields', () => {
      const schema = loadSchema('governance-state-projection.json');
      const required = schema.required as string[];
      for (const field of [
        'sessionId',
        'phase',
        'haltReason',
        'enforcementActive',
        'resumable',
        'riskGate',
      ]) {
        expect(required).toContain(field);
      }
    });

    it('haltReason and riskGate remain nullable', () => {
      const schema = loadSchema('governance-state-projection.json');
      const props = schema.properties as Record<string, Record<string, unknown>>;
      expect(props.haltReason!.type).toContain('null');
      expect(props.riskGate!.oneOf).toBeDefined();
    });
  });

  describe('HAPPY: deny codes baseline covers established adapter/identity codes', () => {
    it('deny-codes.json exists and has codes array', () => {
      const schema = loadSchema('deny-codes.json');
      expect(schema.required).toContain('codes');
    });

    it('adapter and identity codes remain pinned', () => {
      const schema = loadSchema('deny-codes.json');
      const pinned = schema.properties_pinned as Record<string, string[]>;
      expect(pinned.adapter_codes).toContain('REVIEWER_INVOCATION_EXHAUSTED');
      expect(pinned.adapter_codes).toContain('GIT_NOT_FOUND');
      expect(pinned.identity_codes).toContain('DECISION_IDENTITY_REQUIRED');
      expect(pinned.identity_codes).toContain('FOUR_EYES_ACTOR_MATCH');
    });
  });

  describe('EDGE: enforcement and optional hooks', () => {
    it('synchronous capability profile includes preToolBlock', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const defs = schema.$defs as Record<string, Record<string, unknown>>;
      const capProps = defs.HostCapabilities!.properties as Record<string, unknown>;
      expect(capProps).toHaveProperty('preToolBlock');
    });

    it('injectCompactionContext is optional but declared', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const required = schema.required as string[];
      const props = schema.properties as Record<string, unknown>;
      expect(required).not.toContain('injectCompactionContext');
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
    it('HostAdapter and EnforcementLevel unions remain compile-time pinned', () => {
      const platforms: HostAdapter['platform'][] = ['opencode', 'claude-code', 'codex'];
      const levels: EnforcementLevel[] = ['synchronous', 'hook_gated', 'advisory'];
      expect(platforms).toHaveLength(3);
      expect(levels).toHaveLength(3);
    });

    it('EnforcementDecision discriminates on blocked field', () => {
      const block: EnforcementDecision = { blocked: true, reason: 'test', code: 'TEST' };
      const allow: EnforcementDecision = { blocked: false };
      expect(block.blocked).toBe(true);
      expect(allow.blocked).toBe(false);
    });

    it('HostCapabilities has six top-level fields and transport capability is atomic', () => {
      const transport: HostReviewTransportCapability = {
        kind: 'native_task_structured_followup',
        structuredOutput: true,
        parentVisible: true,
        transcriptNavigable: true,
        isolatedAgentIdentity: true,
        permissionIsolation: true,
        assurance: 'structured_high',
      };
      const caps: HostCapabilities = {
        preToolBlock: true,
        argMutation: false,
        outputReplacement: true,
        contextInjection: false,
        reviewTransports: [transport],
        compactionInjection: false,
      };
      expect(Object.keys(caps)).toHaveLength(6);
      expect(caps.reviewTransports[0]).toBe(transport);
    });
  });
});
