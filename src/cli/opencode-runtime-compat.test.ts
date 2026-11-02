/**
 * @module cli/opencode-runtime-compat.test
 * @description Unit tests for the exact OpenCode host-version pin and its
 * deny-list classification.
 */

import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import {
  classifyOpenCodeHostContract,
  KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS,
  TESTED_OPENCODE_HOST_VERSION,
  type OpenCodeHostContractDenyEntry,
} from './opencode-runtime-compat.js';

const withHostVersionBump = (bump: 'minor' | 'patch'): string => {
  const [major = 0, minor = 0, patch = 0] = TESTED_OPENCODE_HOST_VERSION.split('.').map((part) =>
    Number.parseInt(part, 10),
  );
  return bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`;
};

describe('opencode-runtime-compat', () => {
  describe('host contract compatibility matrix', () => {
    it('ships an empty host-contract deny-list', () => {
      expect(KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS).toEqual([]);
    });

    it('HAPPY: classifies the exact tested host version as verified', () => {
      const result = classifyOpenCodeHostContract(TESTED_OPENCODE_HOST_VERSION);
      expect(result.status).toBe('verified');
      expect(result.testedVersion).toBe(TESTED_OPENCODE_HOST_VERSION);
    });

    it('BAD: a newer patch in the same minor line is compatible-unverified', () => {
      const result = classifyOpenCodeHostContract(withHostVersionBump('patch'));
      expect(result.status).toBe('compatible-unverified');
      expect(result.reason).toContain('does not exactly match');
    });

    it('BAD: an older version is compatible-unverified, never verified', () => {
      const result = classifyOpenCodeHostContract('1.15.13');
      expect(result.status).toBe('compatible-unverified');
      expect(result.reason).toContain('does not exactly match');
    });

    it('BAD: a newer minor is compatible-unverified, never verified', () => {
      expect(classifyOpenCodeHostContract(withHostVersionBump('minor')).status).toBe(
        'compatible-unverified',
      );
    });

    it('BAD: a positively known incompatible version is blocked', () => {
      const deny: readonly OpenCodeHostContractDenyEntry[] = [
        {
          versionRange: '>=1.20.0 <1.21.0',
          reason: 'hook generation changes break synchronous blocking',
          verifiedBy: 'synthetic-test-fixture',
        },
      ];
      const result = classifyOpenCodeHostContract('1.20.3', deny);
      expect(result.status).toBe('known-incompatible');
      expect(result.matched?.reason).toContain('synchronous blocking');
    });

    it('CORNER: unknown or malformed versions are compatible-unverified', () => {
      expect(classifyOpenCodeHostContract(null).status).toBe('compatible-unverified');
      expect(classifyOpenCodeHostContract('not-a-version').status).toBe('compatible-unverified');
    });

    it('HAPPY: the tested host version stays in sync with the OpenCode host baseline', () => {
      // Enforceable guard for the scheduled SDK/host update workflow: the
      // canonical constant and the baseline file are two representations of
      // the same tested version and must never drift apart.
      const baseline = JSON.parse(
        readFileSync(
          new URL('../../.sdk-baselines/opencode/host-version.json', import.meta.url),
          'utf-8',
        ),
      ) as { version: string };
      expect(TESTED_OPENCODE_HOST_VERSION).toBe(baseline.version);
    });

    it('EDGE: prerelease/nightly builds do not inherit verified status', () => {
      expect(
        classifyOpenCodeHostContract(`${TESTED_OPENCODE_HOST_VERSION}-nightly.20260901`).status,
      ).toBe('compatible-unverified');
    });
  });
});
