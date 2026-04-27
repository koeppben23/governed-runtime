/**
 * @module integration/identity-policy-e2e.test
 * @description E2E tests for identity-policy chain:
 *   config → hydrate → policySnapshot → preset defaults + config overrides.
 *
 * Verifies that P1a governance fields (minimumActorAssuranceForApproval,
 * identityProviderMode, actorClassification, allowSelfApproval) are
 * correctly frozen from policy presets AND config overrides in the
 * session snapshot.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate } from './tools/index.js';
import { readState } from '../adapters/persistence.js';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

// ─── Workspace Mock ──────────────────────────────────────────────────────────

const wsOriginals = vi.hoisted(() => ({
  archiveSession:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['archiveSession'],
  verifyArchive:
    null as unknown as (typeof import('../adapters/workspace/index.js'))['verifyArchive'],
}));

vi.mock('../adapters/workspace', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  wsOriginals.archiveSession = original.archiveSession;
  wsOriginals.verifyArchive = original.verifyArchive;
  return {
    ...original,
    archiveSession: vi.fn(original.archiveSession),
    verifyArchive: vi.fn(original.verifyArchive),
  };
});

// ─── Actor Mock ──────────────────────────────────────────────────────────────

const actorOriginal = vi.hoisted(() => ({
  resolveActor: null as unknown as (typeof import('../adapters/actor.js'))['resolveActor'],
}));

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  actorOriginal.resolveActor = original.resolveActor;
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
    }),
  };
});

const actorMock = await import('../adapters/actor.js');

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  const wsSpy = await import('../adapters/workspace/index.js');
  vi.mocked(wsSpy.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsSpy.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  delete process.env.FLOWGUARD_POLICY_PATH;
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const args: { policyMode: string; profileId?: string } = {
    policyMode: overrides.policyMode ?? 'solo',
  };
  if (overrides.profileId !== undefined) {
    args.profileId = overrides.profileId;
  }
  const raw = await hydrate.execute(args, ctx);
  return parseToolResult(raw);
}

async function resolveSessionDirFor(sessionId: string): Promise<string> {
  const { computeFingerprint, sessionDir } = await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return sessionDir(fp.fingerprint, sessionId);
}

// ─── Tests ──────────────────────────────────────────────────────────────────────

describe('identity-policy-e2e', () => {
  describe('HAPPY — hydrate persists preset governance fields', () => {
    it('solo: minimumActorAssuranceForApproval = best_effort', async () => {
      await hydrateSession({ policyMode: 'solo' });
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.minimumActorAssuranceForApproval).toBe('best_effort');
    });

    it('team: identityProviderMode = optional', async () => {
      await hydrateSession({ policyMode: 'team' });
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.identityProviderMode).toBe('optional');
    });

    it('regulated: allowSelfApproval = false', async () => {
      await hydrateSession({ policyMode: 'regulated' });
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.allowSelfApproval).toBe(false);
    });
  });

  describe('CORNER — P1a field completeness', () => {
    it('solo snapshot includes all governance-critical fields', async () => {
      await hydrateSession({ policyMode: 'solo' });
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      const ps = state!.policySnapshot;

      expect(ps.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(ps.identityProviderMode).toBe('optional');
      expect(ps.actorClassification).toBeDefined();
      expect(ps.audit).toBeDefined();
      expect(ps.requireHumanGates).toBe(false);
      expect(ps.maxSelfReviewIterations).toBeGreaterThan(0);
    });
  });

  describe('BAD — config identityProvider flows to snapshot', () => {
    it('identityProviderMode=required from config persists in policySnapshot', async () => {
      // First hydrate creates workspace config
      await hydrateSession({ policyMode: 'solo' });

      // Write config with idpMode=required + identityProvider
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const config = await readConfig(wsDir);
      config.policy.identityProviderMode = 'required';
      config.policy.identityProvider = {
        mode: 'static',
        issuer: 'https://idp.example.com',
        audience: 'flowguard',
        claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
        signingKeys: [
          {
            kind: 'jwk' as const,
            kid: 'key-1',
            alg: 'RS256' as const,
            jwk: { kty: 'RSA' as const, n: 'dGVzdA', e: 'AQAB' },
          },
        ],
      } as unknown as typeof config.policy.identityProvider;
      await writeConfig(wsDir, config);

      // Verify config write succeeded
      const verifyConfig = await readConfig(wsDir);
      expect(verifyConfig.policy.identityProviderMode).toBe('required');

      // New session picks up config
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const raw = await hydrate.execute({ policyMode: 'team', profileId: 'baseline' }, ctx2);
      const hydrateResult = parseToolResult(raw);
      expect(hydrateResult.error).toBeUndefined();

      const sessDir2 = await resolveSessionDirFor(ctx2.sessionID);
      const state = await readState(sessDir2);
      expect(state).not.toBeNull();
      // Config fields flow through to snapshot
      expect(state!.policySnapshot.identityProviderMode).toBe('required');
      expect(state!.policySnapshot.identityProvider).toBeDefined();
    });
  });
});
