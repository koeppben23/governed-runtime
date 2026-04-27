/**
 * @module config/policy-resolution.test
 * @description Unit tests for policy resolution — runtime context, central policy, hydrate authority.
 *
 * Coverage: HAPPY, BAD, CORNER, EDGE
 * - HAPPY: mode resolution, CI degradation, central policy uplift
 * - BAD: invalid modes, corrupt central policy, missing path
 * - CORNER: mode strength boundaries, empty central path, existing session validation
 * - EDGE: explicit stronger than central, team-ci without CI, config overrides
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { describe, expect, it } from 'vitest';
import {
  modeStrength,
  resolvePolicyWithContext,
  resolveRuntimePolicyMode,
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
  resolvePolicyForHydrate,
} from './policy-resolution.js';
import { PolicyConfigurationError } from './policy-presets.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

function sha256Stub(text: string): string {
  return `sha256:${text.length}`;
}

function makeCentralPolicy(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    schemaVersion: 'v1',
    minimumMode: 'team',
    ...overrides,
  });
}

function mockReadFile(content: string): (path: string) => Promise<string> {
  return async () => content;
}

function mockReadFileError(code: string, message: string): (path: string) => Promise<string> {
  return async () => {
    const err = new Error(message) as Error & { code: string };
    err.code = code;
    throw err;
  };
}

// ─── modeStrength ───────────────────────────────────────────────────────────

describe('modeStrength', () => {
  it('ranks solo < team < regulated', () => {
    expect(modeStrength('solo')).toBeLessThan(modeStrength('team'));
    expect(modeStrength('team')).toBeLessThan(modeStrength('regulated'));
  });

  it('ranks team and team-ci equally', () => {
    expect(modeStrength('team')).toBe(modeStrength('team-ci'));
  });

  it('returns 1 for solo, 2 for team/team-ci, 3 for regulated', () => {
    expect(modeStrength('solo')).toBe(1);
    expect(modeStrength('team')).toBe(2);
    expect(modeStrength('team-ci')).toBe(2);
    expect(modeStrength('regulated')).toBe(3);
  });
});

// ─── resolvePolicyWithContext ────────────────────────────────────────────────

describe('resolvePolicyWithContext', () => {
  describe('HAPPY: standard mode resolution', () => {
    it('resolves solo mode', () => {
      const result = resolvePolicyWithContext('solo', false);
      expect(result.requestedMode).toBe('solo');
      expect(result.effectiveMode).toBe('solo');
      expect(result.effectiveGateBehavior).toBe('auto_approve');
      expect(result.degradedReason).toBeUndefined();
    });

    it('resolves team mode', () => {
      const result = resolvePolicyWithContext('team', false);
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveGateBehavior).toBe('human_gated');
    });

    it('resolves team-ci mode in CI context', () => {
      const result = resolvePolicyWithContext('team-ci', true);
      expect(result.effectiveMode).toBe('team-ci');
      expect(result.effectiveGateBehavior).toBe('auto_approve');
      expect(result.degradedReason).toBeUndefined();
    });

    it('resolves regulated mode', () => {
      const result = resolvePolicyWithContext('regulated', false);
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveGateBehavior).toBe('human_gated');
      expect(result.policy.allowSelfApproval).toBe(false);
    });
  });

  describe('EDGE: team-ci degradation', () => {
    it('degrades team-ci to team when CI context is absent', () => {
      const result = resolvePolicyWithContext('team-ci', false);
      expect(result.requestedMode).toBe('team-ci');
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveGateBehavior).toBe('human_gated');
      expect(result.degradedReason).toBe('ci_context_missing');
    });
  });

  describe('BAD: invalid mode', () => {
    it('throws PolicyConfigurationError for unknown mode', () => {
      expect(() => resolvePolicyWithContext('invalid')).toThrow(PolicyConfigurationError);
    });

    it('throws with correct error code', () => {
      try {
        resolvePolicyWithContext('chaos');
        expect.unreachable('should have thrown');
      } catch (err) {
        expect((err as PolicyConfigurationError).code).toBe('INVALID_POLICY_MODE');
      }
    });
  });
});

// ─── loadCentralPolicyEvidence ──────────────────────────────────────────────

describe('loadCentralPolicyEvidence', () => {
  describe('HAPPY: valid central policy', () => {
    it('loads and parses a valid central policy', async () => {
      const raw = makeCentralPolicy();
      const evidence = await loadCentralPolicyEvidence(
        '/repo/.flowguard-policy.json',
        sha256Stub,
        mockReadFile(raw),
      );
      expect(evidence.minimumMode).toBe('team');
      expect(evidence.digest).toBe(`sha256:${raw.length}`);
      expect(evidence.pathHint).toBe('basename:.flowguard-policy.json');
    });

    it('captures version and policyId when present', async () => {
      const raw = makeCentralPolicy({ version: '2.0', policyId: 'corp-123' });
      const evidence = await loadCentralPolicyEvidence('/p.json', sha256Stub, mockReadFile(raw));
      expect(evidence.version).toBe('2.0');
    });

    it('supports regulated minimumMode', async () => {
      const raw = makeCentralPolicy({ minimumMode: 'regulated' });
      const evidence = await loadCentralPolicyEvidence('/p.json', sha256Stub, mockReadFile(raw));
      expect(evidence.minimumMode).toBe('regulated');
    });
  });

  describe('BAD: invalid central policy', () => {
    it('throws for empty path', async () => {
      await expect(loadCentralPolicyEvidence('', sha256Stub)).rejects.toThrow(
        PolicyConfigurationError,
      );
    });

    it('throws for whitespace-only path', async () => {
      await expect(loadCentralPolicyEvidence('   ', sha256Stub)).rejects.toThrow(
        PolicyConfigurationError,
      );
    });

    it('throws CENTRAL_POLICY_MISSING when file does not exist', async () => {
      await expect(
        loadCentralPolicyEvidence(
          '/missing.json',
          sha256Stub,
          mockReadFileError('ENOENT', 'not found'),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_MISSING' });
    });

    it('throws CENTRAL_POLICY_UNREADABLE for permission errors', async () => {
      await expect(
        loadCentralPolicyEvidence(
          '/p.json',
          sha256Stub,
          mockReadFileError('EACCES', 'permission denied'),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('throws for non-JSON content', async () => {
      await expect(
        loadCentralPolicyEvidence('/p.json', sha256Stub, mockReadFile('not json')),
      ).rejects.toThrow(PolicyConfigurationError);
    });

    it('throws for wrong schemaVersion', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v2', minimumMode: 'team' });
      await expect(
        loadCentralPolicyEvidence('/p.json', sha256Stub, mockReadFile(raw)),
      ).rejects.toThrow(PolicyConfigurationError);
    });

    it('throws for invalid minimumMode', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'chaos' });
      await expect(
        loadCentralPolicyEvidence('/p.json', sha256Stub, mockReadFile(raw)),
      ).rejects.toThrow(PolicyConfigurationError);
    });
  });
});

// ─── validateExistingPolicyAgainstCentral ────────────────────────────────────

describe('validateExistingPolicyAgainstCentral', () => {
  it('returns undefined when no central policy path', async () => {
    const result = await validateExistingPolicyAgainstCentral({
      existingMode: 'solo',
      digestFn: sha256Stub,
    });
    expect(result).toBeUndefined();
  });

  it('passes when existing mode is stronger than central minimum', async () => {
    const raw = makeCentralPolicy({ minimumMode: 'team' });
    const result = await validateExistingPolicyAgainstCentral({
      existingMode: 'regulated',
      centralPolicyPath: '/p.json',
      digestFn: sha256Stub,
      readFileFn: mockReadFile(raw),
    });
    expect(result).toBeDefined();
    expect(result!.minimumMode).toBe('team');
  });

  it('passes when existing mode equals central minimum', async () => {
    const raw = makeCentralPolicy({ minimumMode: 'team' });
    const result = await validateExistingPolicyAgainstCentral({
      existingMode: 'team',
      centralPolicyPath: '/p.json',
      digestFn: sha256Stub,
      readFileFn: mockReadFile(raw),
    });
    expect(result).toBeDefined();
  });

  it('throws EXISTING_POLICY_WEAKER_THAN_CENTRAL when mode is too weak', async () => {
    const raw = makeCentralPolicy({ minimumMode: 'regulated' });
    await expect(
      validateExistingPolicyAgainstCentral({
        existingMode: 'solo',
        centralPolicyPath: '/p.json',
        digestFn: sha256Stub,
        readFileFn: mockReadFile(raw),
      }),
    ).rejects.toMatchObject({ code: 'EXISTING_POLICY_WEAKER_THAN_CENTRAL' });
  });
});

// ─── resolvePolicyForHydrate ────────────────────────────────────────────────

describe('resolvePolicyForHydrate', () => {
  describe('HAPPY: without central policy', () => {
    it('uses explicit mode as highest priority', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        digestFn: sha256Stub,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.requestedMode).toBe('regulated');
    });

    it('falls back to repoMode when no explicit mode', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        digestFn: sha256Stub,
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveSource).toBe('repo');
    });

    it('falls back to defaultMode when nothing else specified', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn: sha256Stub,
      });
      expect(result.effectiveMode).toBe('solo');
      expect(result.effectiveSource).toBe('default');
    });
  });

  describe('EDGE: central policy interaction', () => {
    it('uplifts default mode when central minimum is stronger', async () => {
      const raw = makeCentralPolicy({ minimumMode: 'team' });
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: '/p.json',
        digestFn: sha256Stub,
        readFileFn: mockReadFile(raw),
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('default_weaker_than_central');
      expect(result.centralEvidence).toBeDefined();
    });

    it('uplifts repo mode when central minimum is stronger', async () => {
      const raw = makeCentralPolicy({ minimumMode: 'regulated' });
      const result = await resolvePolicyForHydrate({
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: '/p.json',
        digestFn: sha256Stub,
        readFileFn: mockReadFile(raw),
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('repo_weaker_than_central');
    });

    it('throws when explicit mode is weaker than central minimum', async () => {
      const raw = makeCentralPolicy({ minimumMode: 'regulated' });
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'solo',
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: '/p.json',
          digestFn: sha256Stub,
          readFileFn: mockReadFile(raw),
        }),
      ).rejects.toMatchObject({ code: 'EXPLICIT_WEAKER_THAN_CENTRAL' });
    });

    it('keeps explicit mode when stronger than central', async () => {
      const raw = makeCentralPolicy({ minimumMode: 'team' });
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: '/p.json',
        digestFn: sha256Stub,
        readFileFn: mockReadFile(raw),
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.resolutionReason).toBe('explicit_stronger_than_central');
    });
  });

  describe('CORNER: config overrides', () => {
    it('applies maxSelfReviewIterations override', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: sha256Stub,
        configMaxSelfReviewIterations: 5,
      });
      expect(result.policy.maxSelfReviewIterations).toBe(5);
    });

    it('applies maxImplReviewIterations override', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: sha256Stub,
        configMaxImplReviewIterations: 7,
      });
      expect(result.policy.maxImplReviewIterations).toBe(7);
    });

    it('applies minimumActorAssuranceForApproval override', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: sha256Stub,
        configMinimumActorAssuranceForApproval: 'idp_verified',
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('idp_verified');
    });

    it('translates legacy requireVerifiedActorsForApproval to claim_validated', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'team',
        ciContext: false,
        digestFn: sha256Stub,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('degrades team-ci to team in hydrate without CI', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team-ci',
        defaultMode: 'solo',
        ciContext: false,
        digestFn: sha256Stub,
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.degradedReason).toBe('ci_context_missing');
    });
  });
});

// ─── resolveRuntimePolicyMode ───────────────────────────────────────────────

describe('resolveRuntimePolicyMode', () => {
  it('returns mode from state snapshot when present', () => {
    expect(
      resolveRuntimePolicyMode({
        state: { policySnapshot: { mode: 'regulated' } },
        configDefaultMode: 'solo',
      }),
    ).toBe('regulated');
  });

  it('falls back to configDefaultMode when no state', () => {
    expect(resolveRuntimePolicyMode({ configDefaultMode: 'team' })).toBe('team');
  });

  it('falls back to solo when nothing is provided', () => {
    expect(resolveRuntimePolicyMode({})).toBe('solo');
  });

  it('falls back to solo when state has no policySnapshot', () => {
    expect(resolveRuntimePolicyMode({ state: {} })).toBe('solo');
  });

  it('falls back to solo when policySnapshot has no mode', () => {
    expect(resolveRuntimePolicyMode({ state: { policySnapshot: {} } })).toBe('solo');
  });
});
