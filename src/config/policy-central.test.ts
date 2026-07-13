import { describe, it, expect } from 'vitest';
import {
  SOLO_POLICY,
  TEAM_POLICY,
  TEAM_CI_POLICY,
  REGULATED_POLICY,
  PolicyConfigurationError,
  detectCiContext,
  getPolicyPreset,
  resolvePolicyWithContext,
  resolvePolicyForHydrate,
  policyModes,
  createPolicySnapshot,
  resolvePolicyFromSnapshot,
  loadCentralPolicyEvidence,
  validateExistingPolicyAgainstCentral,
} from '../config/policy.js';

const POLICY_PATH = '/tmp/p.json';
const digestFn = (s: string): string => `sha256:${s.length}`;

describe('config/policy', () => {
  describe('MUTATION: validateExistingPolicyAgainstCentral', () => {
    it('passes when existingMode equals central minimum (boundary)', async () => {
      const result = await validateExistingPolicyAgainstCentral({
        existingMode: 'team',
        centralPolicyPath: '/tmp/org-policy.json',
        digestFn: (s) => `sha256:${s.length}`,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
      });
      expect(result).toBeDefined();
      expect(result!.minimumMode).toBe('team');
    });

    it('throws when existingMode is weaker with descriptive message', async () => {
      await expect(
        validateExistingPolicyAgainstCentral({
          existingMode: 'solo',
          centralPolicyPath: '/tmp/org-policy.json',
          digestFn: (s) => `sha256:${s.length}`,
          readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
        }),
      ).rejects.toThrow(/solo.*weaker.*team/i);
    });

    it('returns undefined when no central policy path', async () => {
      const result = await validateExistingPolicyAgainstCentral({
        existingMode: 'solo',
        digestFn: (s) => s,
      });
      expect(result).toBeUndefined();
    });
  });

  describe('MUTATION: loadCentralPolicyEvidence', () => {
    it('throws CENTRAL_POLICY_INVALID_JSON for malformed JSON', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => 'not-json{{{',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_JSON' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for JSON null', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => 'null',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for JSON string', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => '"hello"',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for JSON array', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => '[]',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for wrong schemaVersion', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v2', minimumMode: 'solo' }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_MODE for invalid minimumMode', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'enterprise' }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_MODE' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for non-string version', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: 123 }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('throws CENTRAL_POLICY_INVALID_SCHEMA for non-string policyId', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', policyId: 42 }),
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('includes version in evidence when provided as string', async () => {
      const result = await loadCentralPolicyEvidence(
        POLICY_PATH,
        (s) => `sha256:${s.length}`,
        async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo', version: '2026.04' }),
      );
      expect(result.version).toBe('2026.04');
    });

    it('pathHint contains basename of the policy file', async () => {
      const result = await loadCentralPolicyEvidence(
        '/var/lib/flowguard/org-policy.json',
        (s) => `sha256:${s.length}`,
        async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo' }),
      );
      expect(result.pathHint).toBe('basename:org-policy.json');
    });

    it('throws CENTRAL_POLICY_PATH_EMPTY for empty path', async () => {
      await expect(
        loadCentralPolicyEvidence(
          '',
          (s) => s,
          async () => '{}',
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_PATH_EMPTY' });
    });

    it('throws CENTRAL_POLICY_MISSING for ENOENT error', async () => {
      await expect(
        loadCentralPolicyEvidence(
          '/tmp/missing.json',
          (s) => s,
          async () => {
            const err = new Error('ENOENT') as Error & { code: string };
            err.code = 'ENOENT';
            throw err;
          },
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_MISSING' });
    });

    it('throws CENTRAL_POLICY_UNREADABLE for non-ENOENT error', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => {
            const err = new Error('Permission denied') as Error & { code: string };
            err.code = 'EACCES';
            throw err;
          },
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('throws CENTRAL_POLICY_UNREADABLE for error without code', async () => {
      await expect(
        loadCentralPolicyEvidence(
          POLICY_PATH,
          (s) => s,
          async () => {
            throw new Error('Something went wrong');
          },
        ),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('computes digest from raw file content', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      const result = await loadCentralPolicyEvidence(
        POLICY_PATH,
        (s) => `sha256:${s}`,
        async () => raw,
      );
      expect(result.digest).toBe(`sha256:${raw}`);
    });
  });

  describe('MUTATION: resolvePolicyForHydrate central', () => {
    const centralTeam = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
    const centralRegulated = JSON.stringify({
      schemaVersion: 'v1',
      minimumMode: 'regulated',
    });
    const centralSolo = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo' });

    it('explicit mode equal to central minimum: no error, no resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralTeam,
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.resolutionReason).toBeUndefined();
    });

    it('explicit weaker than central throws EXPLICIT_WEAKER_THAN_CENTRAL with message', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'solo',
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralTeam,
        }),
      ).rejects.toThrow(/solo.*weaker.*team/i);
    });

    it('explicit stronger than central sets resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralSolo,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('explicit');
      expect(result.resolutionReason).toBe('explicit_stronger_than_central');
    });

    it('repo mode equal to central: no resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'team',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralTeam,
      });
      expect(result.effectiveMode).toBe('team');
      expect(result.effectiveSource).toBe('repo');
      expect(result.resolutionReason).toBeUndefined();
    });

    it('default weaker than central sets default_weaker_than_central', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('default_weaker_than_central');
    });

    it('repo weaker than central sets repo_weaker_than_central', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'solo',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.effectiveMode).toBe('regulated');
      expect(result.effectiveSource).toBe('central');
      expect(result.resolutionReason).toBe('repo_weaker_than_central');
    });

    it('config overrides wired through to central-elevated policy', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configMaxSelfReviewIterations: 10,
        configMaxImplReviewIterations: 20,
        configRequireVerifiedActorsForApproval: true,
        configIdentityProvider: {
          mode: 'jwks',
          issuer: 'https://idp.example.com',
          audience: ['flowguard'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/jwks.json',
          cacheTtlSeconds: 300,
        },
        configIdentityProviderMode: 'required',
      });
      expect(result.policy.maxSelfReviewIterations).toBe(10);
      expect(result.policy.maxImplReviewIterations).toBe(20);
      expect(result.policy.requireVerifiedActorsForApproval).toBe(true);
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(result.policy.identityProvider?.mode).toBe('jwks');
      expect(result.policy.identityProviderMode).toBe('required');
    });

    it('legacy requireVerifiedActors translates to claim_validated on central path', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('configMinimumActorAssurance takes priority over legacy boolean on central path', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configMinimumActorAssuranceForApproval: 'idp_verified',
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('idp_verified');
    });

    it('centralEvidence included in result when central policy resolved', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.centralEvidence).toBeDefined();
      expect(result.centralEvidence!.minimumMode).toBe('regulated');
      expect(result.centralEvidence!.pathHint).toContain('p.json');
    });

    it('idp config wired through when central upgrades to higher mode', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configIdentityProvider: {
          mode: 'jwks',
          issuer: 'https://idp',
          audience: ['fg'],
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          jwksPath: '/etc/jwks.json',
          cacheTtlSeconds: 300,
        },
      });
      expect(result.policy.identityProvider).toBeDefined();
      expect(result.policy.identityProvider!.issuer).toBe('https://idp');
    });
  });

  describe('MUTATION: error message strings', () => {
    it('validateExistingPolicyAgainstCentral error message mentions both modes', async () => {
      const centralTeam = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      await expect(
        validateExistingPolicyAgainstCentral({
          existingMode: 'solo',
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralTeam,
        }),
      ).rejects.toThrow(/solo.*weaker.*team/i);
    });

    it('central policy invalid mode error includes the invalid mode value', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'enterprise' }),
        ),
      ).rejects.toThrow(/enterprise/);
    });

    it('central policy invalid JSON error says "not valid JSON"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => '{broken'),
      ).rejects.toThrow(/not valid JSON/);
    });

    it('central policy non-object error says "must be a JSON object"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => '"hello"'),
      ).rejects.toThrow(/must be a JSON object/);
    });

    it('central policy wrong schemaVersion error mentions "v1"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v2', minimumMode: 'team' }),
        ),
      ).rejects.toThrow(/schemaVersion.*"v1"/);
    });

    it('central policy numeric version error says "version must be a string"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: 123 }),
        ),
      ).rejects.toThrow(/version must be a string/);
    });

    it('central policy numeric policyId error says "policyId must be a string"', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
          JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', policyId: 42 }),
        ),
      ).rejects.toThrow(/policyId must be a string/);
    });

    it('empty path error says "FLOWGUARD_POLICY_PATH is set but empty"', async () => {
      await expect(loadCentralPolicyEvidence('   ', digestFn, async () => '{}')).rejects.toThrow(
        /FLOWGUARD_POLICY_PATH is set but empty/,
      );
    });

    it('non-Error throw produces error message via String()', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          throw 'raw string error';
        }),
      ).rejects.toThrow(/raw string error/);
    });

    it('read failure error message includes path and error text', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          throw new Error('disk failure');
        }),
      ).rejects.toThrow(/cannot be read.*disk failure/i);
    });
  });

  describe('MUTATION: parseCentralPolicyBundle conditional spreads', () => {
    it('JSON number triggers CENTRAL_POLICY_INVALID_SCHEMA', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => '42'),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_INVALID_SCHEMA' });
    });

    it('parses correctly when policyId is present (non-exposed field)', async () => {
      const raw = JSON.stringify({
        schemaVersion: 'v1',
        minimumMode: 'solo',
        policyId: 'org-policy-001',
      });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result.minimumMode).toBe('solo');
    });

    it('version string passes through to evidence', async () => {
      const raw = JSON.stringify({
        schemaVersion: 'v1',
        minimumMode: 'team',
        version: '2026.1',
        policyId: 'test-pol',
      });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result.version).toBe('2026.1');
    });

    it('absent policyId does not produce undefined policyId field', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result).not.toHaveProperty('policyId');
    });

    it('absent version does not produce undefined version field', async () => {
      const raw = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => raw);
      expect(result).not.toHaveProperty('version');
    });

    it('modeStrength: team equals central team (no error)', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team',
        defaultMode: 'solo',
        ciContext: true,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
      });
      expect(result.effectiveMode).toBe('team');
    });

    it('modeStrength: team-ci equals central team (no error)', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'team-ci',
        defaultMode: 'solo',
        ciContext: true,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
      });
      expect(result.effectiveMode).toBe('team-ci');
    });

    it('read error without code property maps to CENTRAL_POLICY_UNREADABLE', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          const e = { message: 'fail', code: 'EPERM' };
          throw e;
        }),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
    });

    it('read error with code ENOENT maps to CENTRAL_POLICY_MISSING', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          const err = Object.assign(new Error('no such file'), { code: 'ENOENT' });
          throw err;
        }),
      ).rejects.toMatchObject({ code: 'CENTRAL_POLICY_MISSING' });
    });

    it('valid string policyId does not throw', async () => {
      const result = await loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () =>
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo', policyId: 'valid-id' }),
      );
      expect(result.minimumMode).toBe('solo');
    });
  });

  describe('MUTATION: resolvePolicyForHydrate legacy & conditional spreads', () => {
    const centralRegulated = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated' });
    const centralSolo = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'solo' });

    it('legacy requireVerifiedActors=false does NOT produce claim_validated (local)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn,
        configRequireVerifiedActorsForApproval: false,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('legacy requireVerifiedActors=true produces claim_validated (local)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        digestFn,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('legacy requireVerifiedActors=false preserves regulated claim_validated default (central)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configRequireVerifiedActorsForApproval: false,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('legacy requireVerifiedActors=true produces claim_validated (central)', async () => {
      const result = await resolvePolicyForHydrate({
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
        configRequireVerifiedActorsForApproval: true,
      });
      expect(result.policy.minimumActorAssuranceForApproval).toBe('claim_validated');
    });

    it('explicit equal to central does NOT set resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralRegulated,
      });
      expect(result.resolutionReason).toBeUndefined();
    });

    it('explicit stronger than central DOES set resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        explicitMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralSolo,
      });
      expect(result.resolutionReason).toBe('explicit_stronger_than_central');
    });

    it('repo stronger than central does NOT set resolutionReason', async () => {
      const result = await resolvePolicyForHydrate({
        repoMode: 'regulated',
        defaultMode: 'solo',
        ciContext: false,
        centralPolicyPath: POLICY_PATH,
        digestFn,
        readFileFn: async () => centralSolo,
      });
      expect(result.resolutionReason).toBeUndefined();
    });

    it('explicit team is weaker than central regulated → throws', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'team',
          defaultMode: 'solo',
          ciContext: false,
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralRegulated,
        }),
      ).rejects.toMatchObject({ code: 'EXPLICIT_WEAKER_THAN_CENTRAL' });
    });

    it('explicit team-ci is weaker than central regulated → throws', async () => {
      await expect(
        resolvePolicyForHydrate({
          explicitMode: 'team-ci',
          defaultMode: 'solo',
          ciContext: true,
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralRegulated,
        }),
      ).rejects.toMatchObject({ code: 'EXPLICIT_WEAKER_THAN_CENTRAL' });
    });

    it('validateExistingPolicyAgainstCentral has correct error code', async () => {
      const centralTeam = JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' });
      await expect(
        validateExistingPolicyAgainstCentral({
          existingMode: 'solo',
          centralPolicyPath: POLICY_PATH,
          digestFn,
          readFileFn: async () => centralTeam,
        }),
      ).rejects.toMatchObject({ code: 'EXISTING_POLICY_WEAKER_THAN_CENTRAL' });
    });

    it('loadCentralPolicyEvidence non-Error throw with code produces CENTRAL_POLICY_UNREADABLE and includes path', async () => {
      const rejection = loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
        throw { code: 'EPERM', message: 'permission denied' };
      });
      await expect(rejection).rejects.toMatchObject({ code: 'CENTRAL_POLICY_UNREADABLE' });
      await expect(rejection).rejects.toThrow(/p\.json/);
    });

    it('loadCentralPolicyEvidence non-Error throw message includes stringified error', async () => {
      await expect(
        loadCentralPolicyEvidence(POLICY_PATH, digestFn, async () => {
          throw 'plain string failure';
        }),
      ).rejects.toThrow(/plain string failure/);
    });
  });
});
