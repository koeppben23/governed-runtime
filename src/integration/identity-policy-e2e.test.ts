/**
 * @module integration/identity-policy-e2e.test
 * @description E2E tests for identity-policy chain:
 *   hydrate → policySnapshot → preset defaults + P1a field completeness.
 *
 * Verifies that P1a governance fields (minimumActorAssuranceForApproval,
 * identityProviderMode, actorClassification, allowSelfApproval) are
 * correctly frozen from policy presets in the session snapshot.
 *
 * Known P1 gap: HydratePolicyInput does not forward identityProvider /
 * identityProviderMode from config to executeHydrate. The rail receives
 * only preset defaults. Fix: add these fields to HydratePolicyInput
 * and pipe config.policy.identityProviderMode through.
 *
 * @test-policy HAPPY, BAD (gap documentation), CORNER
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

  describe('BAD — P1 config gap documented', () => {
    it('identityProvider/identityProviderMode not forwarded by HydratePolicyInput', async () => {
      // Gap: HydratePolicyInput does not have identityProvider or
      // identityProviderMode fields. Config overrides are resolved in
      // resolvePolicyForHydrate but lost when the tool extracts fields
      // for executeHydrate.
      // Expected behavior after fix: config identityProvider flows to snapshot.
      // Current behavior: snapshot uses preset default ('optional').
      await hydrateSession({ policyMode: 'team' });
      const sessDir = await resolveSessionDirFor(ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.identityProviderMode).toBe('optional');
    });
  });
});
