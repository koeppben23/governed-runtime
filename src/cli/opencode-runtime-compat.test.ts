/**
 * @module cli/opencode-runtime-compat.test
 * @description Unit tests for the OpenCode instruction-source classification
 * authority (honest deny-list: not-classified vs. known-unsupported).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyOpenCodeHostContract,
  classifyOpenCodeRuntime,
  KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS,
  KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES,
  TESTED_OPENCODE_HOST_VERSION,
  type OpenCodeHostContractDenyEntry,
  type OpenCodeRuntimeDenyEntry,
  type OpenCodeRuntimeEvidence,
} from './opencode-runtime-compat.js';

const cliEvidence = (over: Partial<OpenCodeRuntimeEvidence> = {}): OpenCodeRuntimeEvidence => ({
  runtimeKind: 'cli',
  version: '1.2.3',
  runtimeLine: null,
  ...over,
});

describe('opencode-runtime-compat', () => {
  describe('HAPPY — honest "not-classified" posture (never "compatible/supported")', () => {
    it('ships an empty deny-list (no runtime known incompatible)', () => {
      expect(KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES).toEqual([]);
    });

    it('classifies a CLI runtime with no runtime-line as not-classified (not supported)', () => {
      expect(classifyOpenCodeRuntime(cliEvidence()).status).toBe('not-classified');
    });

    it('classifies an unknown runtime as not-classified — never compatible', () => {
      const ev = cliEvidence({ runtimeKind: 'unknown', version: null, runtimeLine: null });
      expect(classifyOpenCodeRuntime(ev).status).toBe('not-classified');
    });

    it('classifies a Desktop-owned runtime as not-classified (activation unverified)', () => {
      const ev = cliEvidence({ runtimeKind: 'desktop-owned', version: null, runtimeLine: null });
      expect(classifyOpenCodeRuntime(ev).status).toBe('not-classified');
    });
  });

  describe('BAD — positively known incompatible runtime is blocked', () => {
    const deny: readonly OpenCodeRuntimeDenyEntry[] = [
      {
        runtimeLine: 'legacy-embedded',
        reason: 'accepts instructions[] but never resolves it',
        verifiedBy: 'synthetic-test-fixture',
      },
    ];

    it('flags a runtime-line present on the deny-list as known-unsupported', () => {
      const ev = cliEvidence({ runtimeLine: 'legacy-embedded' });
      const result = classifyOpenCodeRuntime(ev, deny);
      expect(result.status).toBe('known-unsupported');
      expect(result.matched?.runtimeLine).toBe('legacy-embedded');
    });

    it('does not flag a runtime-line absent from the deny-list', () => {
      const ev = cliEvidence({ runtimeLine: 'some-other-line' });
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('not-classified');
    });
  });

  describe('CORNER — version-range matching in deny entries', () => {
    const deny: readonly OpenCodeRuntimeDenyEntry[] = [
      {
        runtimeLine: 'ranged',
        versionRange: '2.1.',
        reason: 'broken in 2.1.x',
        verifiedBy: 'synthetic-test-fixture',
      },
    ];

    it('matches a version inside the prefix range', () => {
      const ev = cliEvidence({ runtimeLine: 'ranged', version: '2.1.9' });
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('known-unsupported');
    });

    it('does not match a version outside the range', () => {
      const ev = cliEvidence({ runtimeLine: 'ranged', version: '2.2.0' });
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('not-classified');
    });

    it('does not match a ranged entry when version is null (cannot confirm)', () => {
      const ev = cliEvidence({ runtimeLine: 'ranged', version: null });
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('not-classified');
    });
  });

  describe('EDGE — deny entry without versionRange applies to all versions', () => {
    const deny: readonly OpenCodeRuntimeDenyEntry[] = [
      {
        runtimeLine: 'all-versions',
        reason: 'entire line broken',
        verifiedBy: 'synthetic-test-fixture',
      },
    ];

    it('matches regardless of version, including null', () => {
      expect(
        classifyOpenCodeRuntime(
          cliEvidence({ runtimeLine: 'all-versions', version: '9.9.9' }),
          deny,
        ).status,
      ).toBe('known-unsupported');
      expect(
        classifyOpenCodeRuntime(cliEvidence({ runtimeLine: 'all-versions', version: null }), deny)
          .status,
      ).toBe('known-unsupported');
    });
  });

  describe('host contract compatibility matrix', () => {
    it('ships an empty host-contract deny-list', () => {
      expect(KNOWN_INCOMPATIBLE_OPENCODE_HOST_CONTRACTS).toEqual([]);
    });

    it('HAPPY: classifies the exact tested host version as verified', () => {
      const result = classifyOpenCodeHostContract('1.18.29');
      expect(result.status).toBe('verified');
      expect(result.testedVersion).toBe(TESTED_OPENCODE_HOST_VERSION);
      expect(result.testedRange).toBe(TESTED_OPENCODE_HOST_VERSION);
    });

    it('BAD: a newer patch in the same minor line is compatible-unverified', () => {
      const result = classifyOpenCodeHostContract('1.18.42');
      expect(result.status).toBe('compatible-unverified');
      expect(result.reason).toContain('does not exactly match');
    });

    it('BAD: an older version is compatible-unverified, never verified', () => {
      const result = classifyOpenCodeHostContract('1.15.13');
      expect(result.status).toBe('compatible-unverified');
      expect(result.reason).toContain('does not exactly match');
    });

    it('BAD: a newer minor is compatible-unverified, never verified', () => {
      expect(classifyOpenCodeHostContract('1.19.0').status).toBe('compatible-unverified');
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

    it('EDGE: prerelease/nightly builds do not inherit verified status', () => {
      expect(classifyOpenCodeHostContract('1.18.29-nightly.20260901').status).toBe(
        'compatible-unverified',
      );
    });
  });
});
