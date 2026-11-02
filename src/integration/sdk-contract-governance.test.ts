/**
 * @module integration/sdk-contract-governance.test
 * @description HAI governance surface contract tests.
 *
 * The HAI contains only ports the product invokes. Host capabilities and
 * review-transport claims are not static adapter booleans; review assurance is
 * owned by the persisted evidence contract.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import * as path from 'node:path';

const root = path.resolve(import.meta.dirname, '..', '..');
const govBaseDir = path.join(root, '.sdk-baselines', 'governance');

function loadSchema(file: string): Record<string, unknown> {
  return JSON.parse(readFileSync(path.join(govBaseDir, file), 'utf-8'));
}

import type { HostAdapter, HostSession } from '../adapters/host-adapter.js';

type _sessionFields = HostSession['sessionId'] & HostSession['directory'];
type _historyPort = ReturnType<HostAdapter['readHistory']>;
type _sessionPort = ReturnType<HostAdapter['getSession']>;

void (undefined as unknown as _sessionFields);
void (undefined as unknown as _historyPort);
void (undefined as unknown as _sessionPort);

describe('SDK Contract: HAI governance surface', () => {
  describe('HAPPY: baseline schema files exist', () => {
    const expectedFiles = ['host-adapter-interface.json', 'deny-codes.json', 'version.json'];
    for (const file of expectedFiles) {
      it(`${file} exists in .sdk-baselines/governance/`, () => {
        expect(existsSync(path.join(govBaseDir, file))).toBe(true);
      });
    }
  });

  describe('HAPPY: HostAdapter contains only invoked ports', () => {
    it('schema requires the minimal port surface', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const required = schema.required as string[];
      expect(required).toEqual(['initialize', 'shutdown', 'getSession', 'readHistory', 'log']);
    });

    it('does not expose static capability or enforcement projections', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const required = schema.required as string[];
      const props = schema.properties as Record<string, unknown>;
      for (const field of [
        'platform',
        'capabilities',
        'enforcementLevel',
        'getWorkingDirectory',
        'getWorktree',
        'validateCapabilities',
        'deliverBlockDecision',
        'isReviewerSupported',
      ]) {
        expect(required).not.toContain(field);
        expect(props).not.toHaveProperty(field);
      }
    });

    it('exposes no direct reviewer spawn capability', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const required = schema.required as string[];
      const props = schema.properties as Record<string, unknown>;
      expect(required).not.toContain('spawnReviewer');
      expect(props).not.toHaveProperty('spawnReviewer');
    });
  });

  describe('HAPPY: exact session and history ports are pinned', () => {
    it('HostSession requires the exact session id and directory', () => {
      const schema = loadSchema('host-adapter-interface.json');
      const session = (schema.$defs as Record<string, Record<string, unknown>>).HostSession!;
      expect(session.required).toEqual(['sessionId', 'directory']);
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

  describe('CORNER: version.json records governance surface metadata', () => {
    it('version.json has platform=governance and source reference', () => {
      const version = loadSchema('version.json');
      expect(version.platform).toBe('governance');
      expect(version.source).toBe('src/adapters/host-adapter.ts');
      expect(version.schemas).toEqual(['host-adapter-interface.json', 'deny-codes.json']);
    });
  });

  describe('BAD: no removed static capability surface survives', () => {
    it('HostAdapter has no platform, capability or enforcement projection', () => {
      const adapter = loadSchema('host-adapter-interface.json');
      const props = adapter.properties as Record<string, unknown>;
      expect(props).not.toHaveProperty('platform');
      expect(props).not.toHaveProperty('capabilities');
      expect(props).not.toHaveProperty('enforcementLevel');
      expect(props).not.toHaveProperty('reviewTransports');
    });
  });
});
