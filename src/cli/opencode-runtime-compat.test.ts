/**
 * @module cli/opencode-runtime-compat.test
 * @description Unit tests for the OpenCode instruction-source classification
 * authority (honest deny-list: configured vs. known-unsupported).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect } from 'vitest';
import {
  classifyOpenCodeRuntime,
  KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES,
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
  describe('HAPPY — honest "configured" posture (never "compatible/supported")', () => {
    it('ships an empty deny-list (no runtime known incompatible)', () => {
      expect(KNOWN_INCOMPATIBLE_OPENCODE_RUNTIMES).toEqual([]);
    });

    it('classifies a CLI runtime with no runtime-line as configured (not supported)', () => {
      expect(classifyOpenCodeRuntime(cliEvidence()).status).toBe('configured');
    });

    it('classifies an unknown runtime as configured — never compatible', () => {
      const ev = cliEvidence({ runtimeKind: 'unknown', version: null, runtimeLine: null });
      expect(classifyOpenCodeRuntime(ev).status).toBe('configured');
    });

    it('classifies a Desktop-owned runtime as configured (activation unverified)', () => {
      const ev = cliEvidence({ runtimeKind: 'desktop-owned', version: null, runtimeLine: null });
      expect(classifyOpenCodeRuntime(ev).status).toBe('configured');
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
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('configured');
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
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('configured');
    });

    it('does not match a ranged entry when version is null (cannot confirm)', () => {
      const ev = cliEvidence({ runtimeLine: 'ranged', version: null });
      expect(classifyOpenCodeRuntime(ev, deny).status).toBe('configured');
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
});
