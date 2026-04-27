/**
 * @module integration/identity-policy-e2e.test
 * @description E2E tests for identity-policy chain:
 *   P1a: config → hydrate → policySnapshot → preset defaults + config overrides.
 *   P1c: config → policySnapshot → decision enforcement → actor assurance gate.
 *
 * P1a verifies that governance fields (minimumActorAssuranceForApproval,
 * identityProviderMode, actorClassification, allowSelfApproval) are
 * correctly frozen from policy presets AND config overrides in the
 * session snapshot.
 *
 * P1c verifies the full governance chain: when a policy requires idp_verified
 * assurance, decisions with weaker actor assurance are BLOCKED, and decisions
 * with sufficient assurance are ALLOWED. Also proves that runtime enforcement
 * uses the persisted policySnapshot — not reconstructed defaults.
 *
 * @test-policy HAPPY, BAD, CORNER
 * @version v2
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  isBlockedResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate, ticket, plan, decision, status } from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';

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
let _prevPolicyPath: string | undefined;
let _prevTokenPath: string | undefined;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
  _prevPolicyPath = process.env.FLOWGUARD_POLICY_PATH;
  _prevTokenPath = process.env.FLOWGUARD_ACTOR_TOKEN_PATH;
  delete process.env.FLOWGUARD_POLICY_PATH;
  delete process.env.FLOWGUARD_ACTOR_TOKEN_PATH;
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
  // Restore env vars to their previous state
  if (_prevPolicyPath === undefined) {
    delete process.env.FLOWGUARD_POLICY_PATH;
  } else {
    process.env.FLOWGUARD_POLICY_PATH = _prevPolicyPath;
  }
  if (_prevTokenPath === undefined) {
    delete process.env.FLOWGUARD_ACTOR_TOKEN_PATH;
  } else {
    process.env.FLOWGUARD_ACTOR_TOKEN_PATH = _prevTokenPath;
  }
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

  // ─── P1c: Identity-Policy Decision Enforcement ───────────────────────────────
  // Proves the full governance chain:
  //   Config/Policy → PolicySnapshot in State → Decision reads policy from snapshot
  //   → Actor is policy-aware resolved → Approval correctly allowed or blocked.

  describe('P1c — identity-policy decision enforcement', () => {
    /**
     * Write config with identity-policy overrides before hydrate.
     * Uses the first-hydrate-writes-config-dir pattern: hydrate once (solo)
     * to bootstrap workspace, then mutate config, then hydrate a fresh session.
     */
    async function writeIdentityPolicyConfig(overrides: {
      identityProviderMode?: 'optional' | 'required';
      identityProvider?: Record<string, unknown>;
      minimumActorAssuranceForApproval?: 'best_effort' | 'claim_validated' | 'idp_verified';
    }): Promise<void> {
      // Bootstrap workspace config directory
      await hydrateSession({ policyMode: 'solo' });

      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const config = await readConfig(wsDir);

      if (overrides.identityProviderMode !== undefined) {
        config.policy.identityProviderMode = overrides.identityProviderMode;
      }
      if (overrides.minimumActorAssuranceForApproval !== undefined) {
        config.policy.minimumActorAssuranceForApproval = overrides.minimumActorAssuranceForApproval;
      }
      if (overrides.identityProvider !== undefined) {
        config.policy.identityProvider =
          overrides.identityProvider as typeof config.policy.identityProvider;
      }
      await writeConfig(wsDir, config);
    }

    /**
     * Advance a hydrated session to PLAN_REVIEW via ticket → plan → self-review convergence.
     * Uses team mode (allowSelfApproval: true) to avoid four-eyes interference.
     * Requires: session already hydrated with team mode.
     */
    async function advanceToPlanReview(): Promise<void> {
      await ticket.execute({ text: 'Implement identity-gated feature', source: 'user' }, ctx);
      await plan.execute({ planText: '## Plan\n1. Implement feature' }, ctx);
      // Self-review loop: converge to PLAN_REVIEW (team mode auto-approves)
      for (let i = 0; i < 5; i++) {
        const s = parseToolResult(await status.execute({}, ctx));
        if (s.phase === 'PLAN_REVIEW') break;
        await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
      }
      // Verify we actually reached PLAN_REVIEW
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.phase).toBe('PLAN_REVIEW');
    }

    /**
     * Full setup: write identity-policy config → hydrate fresh session (team) → advance to PLAN_REVIEW.
     * Returns the session directory for post-decision assertions.
     */
    async function reachPlanReviewWithIdpPolicy(overrides: {
      identityProviderMode?: 'optional' | 'required';
      identityProvider?: Record<string, unknown>;
      minimumActorAssuranceForApproval?: 'best_effort' | 'claim_validated' | 'idp_verified';
    }): Promise<string> {
      await writeIdentityPolicyConfig(overrides);

      // Fresh session picks up mutated config
      ctx = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      await hydrateSession({ policyMode: 'team' });
      await advanceToPlanReview();

      return resolveSessionDirFor(ctx.sessionID);
    }

    // ── Test 1: hydrate succeeds with required IdP and persists policy snapshot ──

    it('hydrate succeeds with identityProviderMode=required and persists snapshot', async () => {
      await writeIdentityPolicyConfig({
        identityProviderMode: 'required',
        minimumActorAssuranceForApproval: 'idp_verified',
        identityProvider: {
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
        } as unknown as Record<string, unknown>,
      });

      // Fresh session with team mode
      ctx = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBeUndefined();

      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.identityProviderMode).toBe('required');
      expect(state!.policySnapshot.minimumActorAssuranceForApproval).toBe('idp_verified');
    });

    // ── Test 2: blocks actor below idp_verified assurance threshold ──

    it('blocks best_effort actor below idp_verified assurance threshold', async () => {
      const sessDir = await reachPlanReviewWithIdpPolicy({
        identityProviderMode: 'required',
        minimumActorAssuranceForApproval: 'idp_verified',
        identityProvider: {
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
        } as unknown as Record<string, unknown>,
      });

      // Actor mock default is best_effort — should be blocked
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Approve plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');

      // State must NOT have advanced
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('PLAN_REVIEW');
    });

    // ── Test 3: claim_validated is below idp_verified in ordinal comparison ──

    it('blocks claim_validated actor below idp_verified assurance threshold', async () => {
      await reachPlanReviewWithIdpPolicy({
        identityProviderMode: 'required',
        minimumActorAssuranceForApproval: 'idp_verified',
        identityProvider: {
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
        } as unknown as Record<string, unknown>,
      });

      // Override actor to claim_validated — still below idp_verified threshold
      vi.mocked(actorMock.resolveActor).mockResolvedValueOnce({
        id: 'test-operator',
        email: 'test@flowguard.dev',
        displayName: null,
        source: 'env' as const,
        assurance: 'claim_validated' as const,
      });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Approve plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      // minimum/current are interpolated into the message by the reason registry
      expect(result.message).toContain('idp_verified');
      expect(result.message).toContain('claim_validated');
    });

    // ── Test 4: idp_verified actor meets threshold and advances state ──

    it('allows idp_verified actor when idp_verified assurance is required', async () => {
      const sessDir = await reachPlanReviewWithIdpPolicy({
        identityProviderMode: 'required',
        minimumActorAssuranceForApproval: 'idp_verified',
        identityProvider: {
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
        } as unknown as Record<string, unknown>,
      });

      // Override actor to idp_verified — meets threshold
      vi.mocked(actorMock.resolveActor).mockResolvedValueOnce({
        id: 'verified-operator',
        email: 'verified@flowguard.dev',
        displayName: 'Verified Operator',
        source: 'env' as const,
        assurance: 'idp_verified' as const,
      });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Approve plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('VALIDATION');

      // State must have advanced
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('VALIDATION');

      // Decision evidence persisted in state
      expect(state!.reviewDecision).toBeDefined();
      expect(state!.reviewDecision!.verdict).toBe('approve');
      expect(state!.reviewDecision!.decidedBy).toBe('verified-operator');
    });

    // ── Test 5: enforcement uses policySnapshot, not reconstructed defaults ──

    it('enforcement uses policySnapshot, not reconstructed policyMode defaults', async () => {
      // Hydrate with team mode (default: minimumActorAssuranceForApproval = 'best_effort')
      await hydrateSession({ policyMode: 'team' });
      await advanceToPlanReview();

      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();

      // Verify team defaults first
      expect(state!.policySnapshot.minimumActorAssuranceForApproval).toBe('best_effort');

      // Patch policySnapshot directly to require idp_verified
      // This simulates a scenario where the snapshot differs from mode defaults
      const patchedState = {
        ...state!,
        policySnapshot: {
          ...state!.policySnapshot,
          minimumActorAssuranceForApproval: 'idp_verified' as const,
        },
      };
      await writeState(sessDir, patchedState);

      // Verify patch persisted
      const reread = await readState(sessDir);
      expect(reread!.policySnapshot.minimumActorAssuranceForApproval).toBe('idp_verified');

      // Decision with best_effort actor → should be BLOCKED by snapshot, not by team defaults
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Approve plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
      // Message must reflect the snapshot's idp_verified threshold, not team default best_effort
      expect(result.message).toContain('idp_verified');
      expect(result.message).toContain('best_effort');
    });

    // ── Test 6: ActorIdentityError at decision when IdP is required but no token ──

    it('decision blocks with ACTOR_IDP_MODE_REQUIRED when actor resolution fails', async () => {
      const sessDir = await reachPlanReviewWithIdpPolicy({
        identityProviderMode: 'required',
        minimumActorAssuranceForApproval: 'idp_verified',
        identityProvider: {
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
        } as unknown as Record<string, unknown>,
      });

      // Simulate: resolveActor throws because IdP mode is required but no token
      const { ActorIdentityError } = actorMock;
      vi.mocked(actorMock.resolveActor).mockRejectedValueOnce(
        new ActorIdentityError(
          'ACTOR_IDP_MODE_REQUIRED',
          'IdP mode is required but FLOWGUARD_ACTOR_TOKEN_PATH is not set',
        ),
      );

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Approve plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_IDP_MODE_REQUIRED');

      // State must NOT have advanced — fail-closed
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('PLAN_REVIEW');
    });

    // ── Test 7: hydrate succeeds despite IdP-required (Option B) ──

    it('hydrate succeeds with idpMode=required even without IdP token (Option B)', async () => {
      await writeIdentityPolicyConfig({
        identityProviderMode: 'required',
        minimumActorAssuranceForApproval: 'idp_verified',
        identityProvider: {
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
        } as unknown as Record<string, unknown>,
      });

      // Fresh session — hydrate does NOT pass IdP config to resolveActor
      // so it never triggers ACTOR_IDP_MODE_REQUIRED
      ctx = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBeUndefined();

      // Session is created, policy snapshot has required mode
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('READY');
      expect(state!.policySnapshot.identityProviderMode).toBe('required');
    });

    // ── Test 8: decision blocks with ACTOR_IDP_MODE_REQUIRED (real runtime, no mock) ──

    it('decision blocks when idpMode=required, idpConfig set, but no token', async () => {
      // Use the helper which sets identityProviderMode: 'required' + identityProvider
      await reachPlanReviewWithIdpPolicy({
        identityProviderMode: 'required',
        identityProvider: {
          mode: 'static',
          issuer: 'https://idp.example.com',
          audience: 'flowguard',
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          signingKeys: [
            {
              kind: 'jwk',
              kid: 'key-1',
              alg: 'RS256',
              jwk: { kty: 'RSA', n: 'dGVzdA', e: 'AQAB' },
            },
          ],
        },
      } as unknown as {
        identityProviderMode: 'required';
        identityProvider: Record<string, unknown>;
      });

      // No token path
      delete process.env.FLOWGUARD_ACTOR_TOKEN_PATH;

      // Use real resolveActor — not mocked
      vi.mocked(actorMock.resolveActor).mockImplementation(
        actorOriginal.resolveActor as unknown as typeof actorMock.resolveActor,
      );

      const raw = await decision.execute(
        { verdict: 'approve', rationale: 'runtime idp test' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(isBlockedResult(result)).toBe(true);
      expect(result.code).toBe('ACTOR_IDP_MODE_REQUIRED');
    });

    // ── Test 9: empty identityProvider blocks with ACTOR_IDP_CONFIG_REQUIRED ──

    it('resolveActorForPolicy rejects empty identityProvider with required mode', async () => {
      const { resolveActorForPolicy } = await import('../adapters/actor-context.js');
      const { ActorIdentityError } = await import('../adapters/actor.js');

      await expect(
        resolveActorForPolicy('/fake/worktree', {
          mode: 'team',
          requireHumanGates: true,
          maxSelfReviewIterations: 3,
          maxImplReviewIterations: 3,
          allowSelfApproval: true,
          selfReview: { subagentEnabled: false, fallbackToSelf: false },
          audit: {
            emitTransitions: true,
            emitToolCalls: true,
            enableChainHash: true,
          },
          actorClassification: {},
          minimumActorAssuranceForApproval: 'best_effort',
          requireVerifiedActorsForApproval: false,
          identityProvider: {} as unknown as undefined,
          identityProviderMode: 'required',
        }),
      ).rejects.toThrow(ActorIdentityError);
    });

    // ── Test 10: full ticket flow with idpMode=required blocks decision ──

    it('full ticket flow blocks decision when idpMode=required and no token', async () => {
      // 1. Config with IdP-required + identityProvider — hydrate picks it up (Option B)
      await writeIdentityPolicyConfig({
        identityProviderMode: 'required',
        identityProvider: {
          mode: 'static',
          issuer: 'https://idp.example.com',
          audience: 'flowguard',
          claimMapping: { subjectClaim: 'sub', emailClaim: 'email', nameClaim: 'name' },
          signingKeys: [
            {
              kind: 'jwk',
              kid: 'key-1',
              alg: 'RS256',
              jwk: { kty: 'RSA', n: 'dGVzdA', e: 'AQAB' },
            },
          ],
        },
      });

      // 2. Fresh session — hydrate succeeds (Option B)
      ctx = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const hydrateResult = await hydrateSession({ policyMode: 'team' });
      expect(hydrateResult.error).toBeUndefined();

      // 3. Verify snapshot has IdP config
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.identityProviderMode).toBe('required');

      // 4. Full ticket flow: ticket → plan → self-review → PLAN_REVIEW
      await advanceToPlanReview();

      // 5. No token path set — decision must block
      delete process.env.FLOWGUARD_ACTOR_TOKEN_PATH;

      // 6. Use real resolveActor (not mocked) for the decision call
      vi.mocked(actorMock.resolveActor).mockImplementation(
        actorOriginal.resolveActor as unknown as typeof actorMock.resolveActor,
      );

      // 7. Decision should block — idpMode=required, idpConfig set, but no token
      const raw = await decision.execute(
        { verdict: 'approve', rationale: 'e2e enforcement test' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(isBlockedResult(result)).toBe(true);
      expect(result.code).toBe('ACTOR_IDP_MODE_REQUIRED');
    });
  });
});
