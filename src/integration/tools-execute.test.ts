/**
 * @module integration/tools-execute.test
 * @description Execution tests for all 10 FlowGuard tool execute() functions.
 *
 * Tests each tool's execute() against real filesystem persistence with
 * OPENCODE_CONFIG_DIR redirected to a temp directory. Git adapter functions
 * (remoteOriginUrl, changedFiles, listRepoSignals) are selectively mocked;
 * all other I/O (workspace init, state read/write, config) runs for real.
 *
 * Scope: Tool behavior, tool-to-state, tool-to-persistence, tool-specific edge cases.
 * NOT in scope: Full multi-step workflows (see e2e-workflow.test.ts).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE, PERF — all five categories present.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
  parseToolResult,
  isBlockedResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  validate,
  review,
  abort_session,
  archive,
} from './tools/index.js';
import { readState, writeState, readAuditTrail } from '../adapters/persistence.js';
import * as persistence from '../adapters/persistence.js';
import {
  makeState,
  makeProgressedState,
  TICKET,
  PLAN_RECORD,
  SELF_REVIEW_CONVERGED,
  REVIEW_APPROVE,
  VALIDATION_PASSED,
  IMPL_EVIDENCE,
  IMPL_REVIEW_CONVERGED,
} from '../__fixtures__.js';
import { resolvePolicyFromState, writeStateWithArtifacts } from './tools/helpers.js';
import { TEAM_POLICY } from '../config/policy.js';

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

// ─── Workspace Mock (P26) ────────────────────────────────────────────────────
// Partial mock: archiveSession and verifyArchive are vi.fn() wrappers that
// default to the real implementations. P26 tests override them per-test.
// All other workspace exports (computeFingerprint, initWorkspace, etc.)
// remain real for full integration fidelity.
//
// Originals are stored via vi.hoisted (survives vi.mock hoisting) so afterEach
// can fully reset the once-queues (vi.clearAllMocks does NOT clear
// mockResolvedValueOnce queues — unconsumed values leak across tests).

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

// ─── Actor Mock (P27) ────────────────────────────────────────────────────────
// Mock resolveActor to return a deterministic actor for integration tests.
// Prevents dependency on real env vars or git config.

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

// Lazy import for per-test overrides
const gitMock = await import('../adapters/git.js');
const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

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
  // Reset workspace mock once-queues to prevent cross-test leaks.
  // vi.clearAllMocks() only clears calls/results, NOT mockResolvedValueOnce
  // queues. If a P26 test fails before consuming its once-mocks, the stale
  // values leak into subsequent tests (e.g. archive manifest test).
  vi.mocked(wsMock.archiveSession).mockReset().mockImplementation(wsOriginals.archiveSession);
  vi.mocked(wsMock.verifyArchive).mockReset().mockImplementation(wsOriginals.verifyArchive);
  // Reset actor mock to default deterministic value (P27)
  vi.mocked(actorMock.resolveActor).mockReset().mockResolvedValue({
    id: 'test-operator',
    email: 'test@flowguard.dev',
    source: 'env',
  });
  delete process.env.FLOWGUARD_POLICY_PATH;
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Hydrate a session and return parsed result. Convenience for setup. */
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

/** Hydrate + ticket. Convenience for tests that need to start from PLAN phase. */
async function hydrateAndTicket(ticketText = 'Fix the auth bug'): Promise<void> {
  await hydrateSession();
  await ticket.execute({ text: ticketText, source: 'user' }, ctx);
}

// =============================================================================
// Tool 1: status
// =============================================================================

describe('status', () => {
  describe('HAPPY', () => {
    it('returns no-session message when no session exists', async () => {
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.phase).toBeNull();
      expect(result.status).toContain('No FlowGuard session');
    });

    it('returns correct phase and fields after hydrate', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.phase).toBe('READY');
      expect(result.sessionId).toBeTruthy();
      expect(result.policyMode).toBe('solo');
      expect(result.hasTicket).toBe(false);
      expect(result.evalKind).toBeTruthy();
      expect(result.next).toBeTruthy();
    });

    it('surfaces appliedPolicy provenance fields', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      const applied = result.appliedPolicy as Record<string, unknown>;
      expect(applied).toBeDefined();
      expect(applied.source).toBe('explicit');
      expect(applied.requestedMode).toBe('solo');
      expect(applied.effectiveMode).toBe('solo');
      expect(applied.centralPolicyDigest).toBeNull();
    });

    it('includes completeness fields', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.completeness).toBeDefined();
      const comp = result.completeness as Record<string, unknown>;
      expect(typeof comp.overallComplete).toBe('boolean');
      expect(typeof comp.summary).toBe('object');
    });

    it('returns detectedStack with unversioned items when no versions detected', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      // Temp workspace has no manifest files on disk — but default mock signals
      // include .ts files and package.json, so stack detection finds unversioned
      // items (typescript, npm). P10: unversioned items are surfaced.
      expect(result.detectedStack).not.toBeNull();
      const ds = result.detectedStack as Record<string, unknown>;
      expect(Array.isArray(ds.items)).toBe(true);
      expect((ds.items as unknown[]).length).toBeGreaterThan(0);
      // No versions detected — versions[] should be empty
      expect(Array.isArray(ds.versions)).toBe(true);
      expect((ds.versions as unknown[]).length).toBe(0);
    });

    it('returns full detectedStack object with summary and versions', async () => {
      await hydrateSession();
      // Resolve session dir and inject detectedStack into persisted state
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      await writeState(sessDir, {
        ...state!,
        detectedStack: {
          summary: 'java=21, spring-boot=3.4.1',
          items: [
            { kind: 'language', id: 'java', version: '21', evidence: 'pom.xml:<java.version>' },
            { kind: 'framework', id: 'spring-boot', version: '3.4.1' },
          ],
          versions: [
            { id: 'java', version: '21', target: 'language', evidence: 'pom.xml:<java.version>' },
            { id: 'spring-boot', version: '3.4.1', target: 'framework' },
          ],
        },
      });
      const result = parseToolResult(await status.execute({}, ctx));

      // Full object — not just the summary string
      expect(result.detectedStack).not.toBeNull();
      expect(typeof result.detectedStack).toBe('object');
      const ds = result.detectedStack as Record<string, unknown>;
      expect(ds.summary).toBe('java=21, spring-boot=3.4.1');
      expect(Array.isArray(ds.items)).toBe(true);
      expect(Array.isArray(ds.versions)).toBe(true);

      const items = ds.items as Array<Record<string, unknown>>;
      expect(items).toHaveLength(2);
      expect(items[0]).toMatchObject({
        kind: 'language',
        id: 'java',
        version: '21',
        evidence: 'pom.xml:<java.version>',
      });
      expect(items[1]).toMatchObject({
        kind: 'framework',
        id: 'spring-boot',
        version: '3.4.1',
      });

      const versions = ds.versions as Array<Record<string, unknown>>;
      expect(versions).toHaveLength(2);
      expect(versions[0]).toMatchObject({
        id: 'java',
        version: '21',
        target: 'language',
        evidence: 'pom.xml:<java.version>',
      });
      expect(versions[1]).toMatchObject({
        id: 'spring-boot',
        version: '3.4.1',
        target: 'framework',
      });
      // evidence absent on second entry — must not be fabricated
      expect(versions[1].evidence).toBeUndefined();
    });

    it('returns verificationCandidates array (empty by default)', async () => {
      await hydrateSession();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(Array.isArray(result.verificationCandidates)).toBe(true);
    });

    it('returns persisted verificationCandidates in status', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      await writeState(sessDir, {
        ...state!,
        verificationCandidates: [
          {
            kind: 'test',
            command: 'pnpm test',
            source: 'package.json:scripts.test',
            confidence: 'high',
            reason: 'Repo-native test script detected and pnpm package manager detected',
          },
        ],
      });

      const result = parseToolResult(await status.execute({}, ctx));
      expect(Array.isArray(result.verificationCandidates)).toBe(true);
      const candidates = result.verificationCandidates as Array<Record<string, unknown>>;
      expect(candidates).toHaveLength(1);
      expect(candidates[0]).toMatchObject({
        kind: 'test',
        command: 'pnpm test',
        source: 'package.json:scripts.test',
        confidence: 'high',
      });
    });
  });

  describe('BAD', () => {
    it('handles missing worktree gracefully', async () => {
      const badCtx = createToolContext({
        worktree: '',
        directory: '',
        sessionID: ctx.sessionID,
      });
      // Should not throw — returns error or no-session
      const raw = await status.execute({}, badCtx);
      const result = parseToolResult(raw);
      expect(result.phase === null || result.error === true).toBe(true);
    });
  });

  describe('CORNER', () => {
    it('reflects ticket state after ticket is recorded', async () => {
      await hydrateAndTicket();
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.hasTicket).toBe(true);
      expect(result.phase).toBe('TICKET');
    });
  });
});

// =============================================================================
// Tool 2: hydrate
// =============================================================================

describe('hydrate', () => {
  describe('HAPPY', () => {
    it('creates a new session with solo policy', async () => {
      const result = await hydrateSession({ policyMode: 'solo' });
      expect(result.phase).toBe('READY');
      expect(result.status).toBe('ok');
      expect(result.profileDetected).toBe(true);
      expect(result.discoveryComplete).toBe(true);
      expect(result.discoverySummary).not.toBeNull();
    });

    it('creates a new session with team policy', async () => {
      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.phase).toBe('READY');
    });

    it('team-ci degrades to team when CI context is missing', async () => {
      const ciVars = [
        'CI',
        'GITHUB_ACTIONS',
        'GITLAB_CI',
        'BUILDKITE',
        'JENKINS_URL',
        'TF_BUILD',
        'TEAMCITY_VERSION',
        'CIRCLECI',
        'DRONE',
        'BITBUCKET_BUILD_NUMBER',
        'BUILDKITE_BUILD_ID',
      ];
      const previous = Object.fromEntries(ciVars.map((v) => [v, process.env[v]]));
      ciVars.forEach((v) => delete process.env[v]);
      try {
        const result = await hydrateSession({ policyMode: 'team-ci' });
        const resolution = result.policyResolution as Record<string, unknown>;
        expect(resolution.requestedMode).toBe('team-ci');
        expect(resolution.effectiveMode).toBe('team');
        expect(resolution.effectiveGateBehavior).toBe('human_gated');
        expect(resolution.reason).toBe('ci_context_missing');
      } finally {
        ciVars.forEach((v) => {
          if (previous[v] === undefined) delete process.env[v];
          else process.env[v] = previous[v];
        });
      }
    });

    it('team-ci stays active when CI context is present', async () => {
      const previousCi = process.env.CI;
      process.env.CI = 'true';
      try {
        const result = await hydrateSession({ policyMode: 'team-ci' });
        const resolution = result.policyResolution as Record<string, unknown>;
        expect(resolution.requestedMode).toBe('team-ci');
        expect(resolution.effectiveMode).toBe('team-ci');
        expect(resolution.effectiveGateBehavior).toBe('auto_approve');
        expect(resolution.reason).toBeNull();
      } finally {
        if (previousCi === undefined) delete process.env.CI;
        else process.env.CI = previousCi;
      }
    });

    it('persists state to session directory on disk', async () => {
      await hydrateSession();
      // Resolve the session dir and verify the file exists
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('READY');
      expect(state!.binding.fingerprint).toBe(fp.fingerprint);
    });

    it('auto-detects TypeScript profile from repo signals', async () => {
      // P31: No profileId = auto-detect (not profileId: 'baseline')
      const result = await hydrateSession({});
      // With tsconfig.json in signals, TypeScript profile should be detected
      expect(result.profileId).toBe('typescript');
      expect(result.profileName).toContain('TypeScript');
    });

    it('workspace and session directories exist on disk', async () => {
      await hydrateSession();
      const {
        computeFingerprint,
        workspaceDir,
        sessionDir: resolveSessionDir,
      } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

      await expect(fs.access(wsDir)).resolves.toBeUndefined();
      await expect(fs.access(sessDir)).resolves.toBeUndefined();
      await expect(fs.access(`${wsDir}/config.json`)).resolves.toBeUndefined();
      await expect(fs.access(`${wsDir}/discovery/discovery.json`)).resolves.toBeUndefined();
      await expect(
        fs.access(`${wsDir}/discovery/profile-resolution.json`),
      ).resolves.toBeUndefined();
      await expect(fs.access(`${sessDir}/discovery-snapshot.json`)).resolves.toBeUndefined();
      await expect(
        fs.access(`${sessDir}/profile-resolution-snapshot.json`),
      ).resolves.toBeUndefined();
    });
  });

  describe('BAD', () => {
    it('returns error for completely invalid context', async () => {
      const badCtx = createToolContext({
        worktree: '',
        directory: '',
        sessionID: '',
      });
      const raw = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, badCtx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
    });

    it('fails closed when existing workspace config is invalid', async () => {
      await hydrateSession();

      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const cfgPath = `${workspaceDir(fp.fingerprint)}/config.json`;
      await fs.writeFile(cfgPath, '{invalid{{{', 'utf-8');

      const result = await hydrateSession();
      expect(result.error).toBe(true);
      expect(result.code).toBe('WORKSPACE_CONFIG_INVALID');
      expect(result.message).toContain('invalid');
    });

    it('fails closed when FLOWGUARD_POLICY_PATH is set but file is missing', async () => {
      process.env.FLOWGUARD_POLICY_PATH = `${ws.tmpDir}/missing-central-policy.json`;
      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('CENTRAL_POLICY_MISSING');
    });

    it('fails closed when FLOWGUARD_POLICY_PATH is empty string', async () => {
      process.env.FLOWGUARD_POLICY_PATH = '';
      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('CENTRAL_POLICY_PATH_EMPTY');
    });

    it('fails closed when FLOWGUARD_POLICY_PATH is whitespace', async () => {
      process.env.FLOWGUARD_POLICY_PATH = '   ';
      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('CENTRAL_POLICY_PATH_EMPTY');
    });

    it('fails closed when central policy file has invalid JSON', async () => {
      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(centralPath, '{invalid-json', 'utf-8');
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('CENTRAL_POLICY_INVALID_JSON');
    });

    it('blocks explicit weaker mode than central minimum', async () => {
      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(
        centralPath,
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated', version: '2026.04' }),
        'utf-8',
      );
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('EXPLICIT_WEAKER_THAN_CENTRAL');
    });

    it('existing session fails closed when central policy file is missing', async () => {
      await hydrateSession({ policyMode: 'solo' });
      process.env.FLOWGUARD_POLICY_PATH = `${ws.tmpDir}/missing-central-policy.json`;
      const result = await hydrateSession({ policyMode: 'solo' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('CENTRAL_POLICY_MISSING');
    });

    it('existing session blocks when existing mode is weaker than central minimum', async () => {
      await hydrateSession({ policyMode: 'solo' });
      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(
        centralPath,
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated', version: '2026.04' }),
        'utf-8',
      );
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      const result = await hydrateSession({ policyMode: 'solo' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('EXISTING_POLICY_WEAKER_THAN_CENTRAL');
    });

    /**
     * Rehydrate fail-closed: legacy session-state.json on disk with missing
     * required snapshot fields must cause /hydrate to return an error.
     *
     * Proves the end-to-end path: file on disk → readState() → Zod reject →
     * PersistenceError → formatError → { error: true }.
     *
     * This is the "no Legacy" proof the reviewer requires.
     */
    async function corruptSnapshotField(field: string): Promise<Record<string, unknown>> {
      // 1. Create a valid session via /hydrate
      await hydrateSession();

      // 2. Locate session dir on disk
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

      // 3. Read valid state, strip the required field, write raw JSON
      //    (bypasses writeState validation — simulates legacy file on disk)
      const state = await readState(sessDir);
      const raw = JSON.parse(JSON.stringify(state));
      delete raw.policySnapshot[field];
      await fs.writeFile(`${sessDir}/session-state.json`, JSON.stringify(raw));

      // 4. Re-hydrate the same session — readState must reject
      const output = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, ctx);
      return parseToolResult(output);
    }

    it('rehydrate rejects legacy snapshot missing actorClassification', async () => {
      const result = await corruptSnapshotField('actorClassification');
      expect(result.error).toBe(true);
      expect(result.message).toMatch(/actorClassification/);
    });

    it('rehydrate rejects legacy snapshot missing effectiveGateBehavior', async () => {
      const result = await corruptSnapshotField('effectiveGateBehavior');
      expect(result.error).toBe(true);
      expect(result.message).toMatch(/effectiveGateBehavior/);
    });

    it('rehydrate rejects legacy snapshot missing requestedMode', async () => {
      const result = await corruptSnapshotField('requestedMode');
      expect(result.error).toBe(true);
      expect(result.message).toMatch(/requestedMode/);
    });

    it('fails closed when repo signals are unavailable on fresh hydrate', async () => {
      vi.mocked(gitMock.listRepoSignals).mockResolvedValueOnce(undefined as never);
      const result = await hydrateSession();
      expect(result.error).toBe(true);
      expect(result.code).toBe('DISCOVERY_RESULT_MISSING');
    });

    it('maps actor claim resolution errors to structured hydrate errors', async () => {
      const { ActorClaimError } = actorMock;
      vi.mocked(actorMock.resolveActor).mockRejectedValueOnce(
        new ActorClaimError('ACTOR_CLAIM_MISSING', 'claim file missing'),
      );

      const result = await hydrateSession({ policyMode: 'team' });
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_CLAIM_MISSING');
    });
  });

  describe('CORNER', () => {
    it('is idempotent: second hydrate returns existing session', async () => {
      const first = await hydrateSession();
      const second = await hydrateSession();
      // Both should succeed, second returns existing
      expect(first.phase).toBe('READY');
      expect(second.phase).toBe('READY');
    });

    it('idempotent hydrate preserves workspace metadata', async () => {
      await hydrateSession();
      await hydrateSession();
      const { computeFingerprint, readWorkspaceInfo } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const info = await readWorkspaceInfo(fp.fingerprint);
      expect(info).not.toBeNull();
      expect(info!.fingerprint).toBe(fp.fingerprint);
    });

    it('existing regulated session remains allowed when central minimum is team', async () => {
      await hydrateSession({ policyMode: 'regulated' });

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);

      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(
        centralPath,
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: '2026.04' }),
        'utf-8',
      );
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      const result = await hydrateSession({ policyMode: 'regulated' });
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('READY');

      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.centralMinimumMode).toBe('team');
      expect(state!.policySnapshot.policyDigest).toMatch(/^[0-9a-f]{64}$/);

      const statusResult = parseToolResult(await status.execute({}, ctx));
      const applied = statusResult.appliedPolicy as Record<string, unknown>;
      expect(applied.centralMinimumMode).toBe('team');
      expect(String(applied.centralPolicyDigest)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('existing session clears stale central policyVersion when current central policy has no version', async () => {
      await hydrateSession({ policyMode: 'regulated' });

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const stateBefore = await readState(sessDir);
      await writeState(sessDir, {
        ...stateBefore!,
        policySnapshot: {
          ...stateBefore!.policySnapshot,
          policyVersion: '2026.04',
        },
      });

      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(
        centralPath,
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team' }),
        'utf-8',
      );
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      const result = await hydrateSession({ policyMode: 'regulated' });
      expect(result.error).toBeUndefined();

      const stateAfter = await readState(sessDir);
      expect(stateAfter).not.toBeNull();
      expect(stateAfter!.policySnapshot.policyVersion).toBeUndefined();

      const statusResult = parseToolResult(await status.execute({}, ctx));
      const applied = statusResult.appliedPolicy as Record<string, unknown>;
      expect(applied.centralPolicyVersion).toBeNull();
    });

    it('central regulated minimum raises weaker repo mode with visible reason', async () => {
      // 1. Create workspace and config
      await hydrateSession({ policyMode: 'solo' });
      const {
        computeFingerprint,
        workspaceDir,
        sessionDir: resolveSessionDir,
      } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const config = await readConfig(wsDir);
      config.policy.defaultMode = 'solo';
      await writeConfig(wsDir, config);

      // 2. Central minimum: regulated
      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(
        centralPath,
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'regulated', version: '2026.04' }),
        'utf-8',
      );
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      // 3. New session without explicit policyMode (repo source)
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const result = parseToolResult(await hydrate.execute({ profileId: 'baseline' }, ctx2));

      const resolution = result.policyResolution as Record<string, unknown>;
      expect(resolution.effectiveMode).toBe('regulated');
      expect(resolution.source).toBe('central');
      expect(resolution.resolutionReason).toBe('repo_weaker_than_central');
      expect(resolution.centralMinimumMode).toBe('regulated');
      expect(String(resolution.centralPolicyDigest)).toMatch(/^[0-9a-f]{64}$/);

      const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
      const state = await readState(sessDir);
      expect(state!.policySnapshot.mode).toBe('regulated');
      expect(state!.policySnapshot.source).toBe('central');
      expect(state!.policySnapshot.resolutionReason).toBe('repo_weaker_than_central');
      expect(state!.policySnapshot.centralMinimumMode).toBe('regulated');
      expect(state!.policySnapshot.policyDigest).toMatch(/^[0-9a-f]{64}$/);
    });

    it('explicit stronger mode remains explicit while preserving central evidence', async () => {
      const centralPath = `${ws.tmpDir}/central-policy.json`;
      await fs.writeFile(
        centralPath,
        JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: '2026.04' }),
        'utf-8',
      );
      process.env.FLOWGUARD_POLICY_PATH = centralPath;

      const result = await hydrateSession({ policyMode: 'regulated' });
      expect(result.phase).toBe('READY');
      const resolution = result.policyResolution as Record<string, unknown>;
      expect(resolution.effectiveMode).toBe('regulated');
      expect(resolution.source).toBe('explicit');
      expect(resolution.resolutionReason).toBe('explicit_stronger_than_central');
      expect(resolution.centralMinimumMode).toBe('team');
      expect(String(resolution.centralPolicyDigest)).toMatch(/^[0-9a-f]{64}$/);
    });

    it('hydrate without explicit mode uses config.policy.defaultMode: regulated', async () => {
      // Enterprise blocker test: install intent must flow through to policySnapshot.
      // 1. Hydrate once to create workspace + session
      await hydrateSession({ policyMode: 'solo' });

      // 2. Write config with regulated as defaultMode
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const config = await readConfig(wsDir);
      config.policy.defaultMode = 'regulated';
      await writeConfig(wsDir, config);

      // 3. Create a NEW session (new sessionID) WITHOUT explicit policyMode
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const raw = await hydrate.execute({ profileId: 'baseline' }, ctx2);
      const result = parseToolResult(raw);

      expect(result.phase).toBe('READY');
      // policySnapshot must reflect config default
      const resolution = result.policyResolution as Record<string, unknown>;
      expect(resolution.requestedMode).toBe('regulated');
      expect(resolution.effectiveMode).toBe('regulated');

      // Also verify persisted state
      const { sessionDir: resolveSessionDir } = await import('../adapters/workspace/index.js');
      const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.mode).toBe('regulated');
    });

    it('hydrate with explicit mode overrides config default', async () => {
      // 1. Create workspace
      await hydrateSession({ policyMode: 'solo' });

      // 2. Set config default to regulated
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const config = await readConfig(wsDir);
      config.policy.defaultMode = 'regulated';
      await writeConfig(wsDir, config);

      // 3. New session with explicit solo — explicit arg wins over config
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const raw = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, ctx2);
      const result = parseToolResult(raw);

      const resolution = result.policyResolution as Record<string, unknown>;
      expect(resolution.requestedMode).toBe('solo');
      expect(resolution.effectiveMode).toBe('solo');
    });

    it('hydrate falls back to solo when config has no defaultMode', async () => {
      // Config has no defaultMode set (fresh workspace with DEFAULT_CONFIG)
      // New session without explicit mode → should default to 'solo'
      const raw = await hydrate.execute({ profileId: 'baseline' }, ctx);
      const result = parseToolResult(raw);

      expect(result.phase).toBe('READY');
      const resolution = result.policyResolution as Record<string, unknown>;
      expect(resolution.requestedMode).toBe('solo');
      expect(resolution.effectiveMode).toBe('solo');
    });

    it('config team default produces human-gated policy', async () => {
      // 1. Create workspace
      await hydrateSession({ policyMode: 'solo' });

      // 2. Set config default to team
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const config = await readConfig(wsDir);
      config.policy.defaultMode = 'team';
      await writeConfig(wsDir, config);

      // 3. New session without explicit mode
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const raw = await hydrate.execute({ profileId: 'baseline' }, ctx2);
      const result = parseToolResult(raw);

      const resolution = result.policyResolution as Record<string, unknown>;
      expect(resolution.requestedMode).toBe('team');
      expect(resolution.effectiveMode).toBe('team');
      expect(resolution.effectiveGateBehavior).toBe('human_gated');
    });

    it('resolvePolicyFromState(null) returns TEAM policy (plugin/helper fallback)', () => {
      // Plugin and helper contexts fall back to team (conservative), not solo.
      // Hydrate has its own developer-friendly solo fallback via the P21 config chain.
      // This distinction is documented in the runtime truth table.
      const policy = resolvePolicyFromState(null);
      expect(policy).toBe(TEAM_POLICY);
      expect(policy.mode).toBe('team');
      expect(policy.requireHumanGates).toBe(true);
    });
  });

  describe('EDGE', () => {
    it('works with repo without remote (path-based fingerprint)', async () => {
      vi.mocked(gitMock.remoteOriginUrl).mockResolvedValueOnce(null);
      const result = await hydrateSession();
      expect(result.phase).toBe('READY');
      expect(result.error).toBeUndefined();
    });

    it('two sessions in same workspace have independent state', async () => {
      // Session 1
      await hydrateSession();
      const ctx1SessionID = ctx.sessionID;

      // Session 2 with different sessionID
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      const raw2 = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, ctx2);
      const result2 = parseToolResult(raw2);
      expect(result2.phase).toBe('READY');

      // Ticket in session 1 only
      await ticket.execute({ text: 'Session 1 ticket', source: 'user' }, ctx);
      const s1 = parseToolResult(await status.execute({}, ctx));
      const s2 = parseToolResult(await status.execute({}, ctx2));
      expect(s1.hasTicket).toBe(true);
      expect(s2.hasTicket).toBe(false);
    });

    it('fails closed when discovery persistence fails', async () => {
      // Force writeDiscovery to throw — simulates disk full, permissions, etc.
      const spy = vi
        .spyOn(persistence, 'writeDiscovery')
        .mockRejectedValueOnce(new Error('Simulated disk write failure'));

      const result = await hydrateSession();

      // Hydrate must fail-closed.
      expect(result.error).toBe(true);
      expect(result.code).toBe('DISCOVERY_PERSIST_FAILED');
      expect(result.message).toContain('disk write failure');

      spy.mockRestore();
    });

    it('fails closed when profile resolution persistence fails', async () => {
      const spy = vi
        .spyOn(persistence, 'writeProfileResolution')
        .mockRejectedValueOnce(new Error('Simulated profile write failure'));

      const result = await hydrateSession();
      expect(result.error).toBe(true);
      expect(result.code).toBe('PROFILE_RESOLUTION_PERSIST_FAILED');
      expect(result.message).toContain('profile write failure');

      spy.mockRestore();
    });

    it('re-materializes missing workspace config on hydrate', async () => {
      await hydrateSession();
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const cfgPath = `${workspaceDir(fp.fingerprint)}/config.json`;
      await fs.unlink(cfgPath);

      const result = await hydrateSession();
      expect(result.phase).toBe('READY');
      await expect(fs.access(cfgPath)).resolves.toBeUndefined();
    });

    it('fails closed when workspace config cannot be written', async () => {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const cfgPath = `${workspaceDir(fp.fingerprint)}/config.json`;
      // Ensure config is missing so hydrate must write it.
      await fs.rm(cfgPath, { force: true });

      const spy = vi
        .spyOn(persistence, 'writeDefaultConfig')
        .mockRejectedValueOnce(new Error('config write denied'));

      const result = await hydrateSession();
      expect(result.error).toBe(true);
      expect(result.code).toBe('WORKSPACE_CONFIG_WRITE_FAILED');
      expect(result.message).toContain('config write denied');

      spy.mockRestore();
    });
  });

  // ── P31: Config as Runtime Authority ────────────────────────────────────────────
  describe('P31 Config as Runtime Authority', () => {
    it('config.profile.defaultId is used when no explicit profileId', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p31-a-');
      try {
        const {
          computeFingerprint,
          workspaceDir,
          sessionDir: resolveSessionDir,
        } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');
        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);
        const baseConfig = await readConfig(wsDir);
        await writeConfig(wsDir, {
          ...baseConfig,
          profile: { ...baseConfig.profile, defaultId: 'typescript' },
        });
        const ctx2 = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
        });
        const result = parseToolResult(await hydrate.execute({}, ctx2));
        expect(result.profileId).toBe('typescript');

        // Stronger assertion: persisted session state must materialize the same profile.
        const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
        const state = await readState(sessDir);
        expect(state).not.toBeNull();
        expect(state!.activeProfile?.id).toBe('typescript');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('explicit profileId wins over config', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p31-explicit-');
      try {
        const {
          computeFingerprint,
          workspaceDir,
          sessionDir: resolveSessionDir,
        } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');

        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);
        const baseConfig = await readConfig(wsDir);
        // Set config default to baseline, then override explicitly to typescript.
        await writeConfig(wsDir, {
          ...baseConfig,
          profile: { ...baseConfig.profile, defaultId: 'baseline' },
        });

        const ctx2 = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
        });
        const result = parseToolResult(await hydrate.execute({ profileId: 'typescript' }, ctx2));

        expect(result.profileId).toBe('typescript');

        // Stronger assertion: rails/session state must match effective explicit profile.
        const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
        const state = await readState(sessDir);
        expect(state).not.toBeNull();
        expect(state!.activeProfile?.id).toBe('typescript');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('explicit profileId=baseline wins over config.defaultId', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p31-baseline-');
      try {
        const {
          computeFingerprint,
          workspaceDir,
          sessionDir: resolveSessionDir,
        } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');

        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);
        const baseConfig = await readConfig(wsDir);
        // Set config default to typescript, but explicitly request baseline.
        await writeConfig(wsDir, {
          ...baseConfig,
          profile: { ...baseConfig.profile, defaultId: 'typescript' },
        });

        const ctx2 = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
        });
        const result = parseToolResult(await hydrate.execute({ profileId: 'baseline' }, ctx2));

        // Explicit "baseline" must win — not config.defaultId.
        expect(result.profileId).toBe('baseline');

        // Persisted session state must also reflect explicit baseline.
        const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
        const state = await readState(sessDir);
        expect(state).not.toBeNull();
        expect(state!.activeProfile?.id).toBe('baseline');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('existing session retains activeProfile despite explicit override attempt', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p31-existing-');
      try {
        const {
          computeFingerprint,
          workspaceDir,
          sessionDir: resolveSessionDir,
        } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');
        const { readState } = await import('../adapters/persistence.js');

        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);
        const baseConfig = await readConfig(wsDir);
        await writeConfig(wsDir, { ...baseConfig });

        // Create first session with baseline.
        const ctx1 = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
        });
        await hydrate.execute({ profileId: 'baseline' }, ctx1);

        // Verify initial session state.
        const sessDir1 = resolveSessionDir(fp.fingerprint, ctx1.sessionID);
        const state1 = await readState(sessDir1);
        expect(state1!.activeProfile?.id).toBe('baseline');

        // Create second call (existing session) but TRY to override profile.
        // P31: Existing sessions should preserve snapshot, not accept new args.
        const ctx2 = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: ctx1.sessionID, // Same session ID = existing session.
        });
        const result = await parseToolResult(
          // Note: args.profileId is effectively ignored for existing sessions in P31.
          await hydrate.execute({ profileId: 'typescript' }, ctx2),
        );
        // Result should still be successful (not an error).
        expect(result.error).toBeUndefined();

        // P31: Existing session must retain original snapshot profile.
        const state2 = await readState(sessDir1);
        expect(state2!.activeProfile?.id).toBe('baseline');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('new session persists config iteration limits in policySnapshot', async () => {
      // Create fresh workspace with config iteration limits
      const tmpDir = await fs.mkdtemp('/tmp/p31-iter-');
      try {
        const {
          computeFingerprint,
          workspaceDir,
          sessionDir: resolveSessionDir,
        } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');
        const { readState } = await import('../adapters/persistence.js');
        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);

        const baseConfig = await readConfig(wsDir);
        await writeConfig(wsDir, {
          ...baseConfig,
          policy: {
            ...baseConfig.policy,
            maxSelfReviewIterations: 5,
            maxImplReviewIterations: 7,
          },
        });

        const ctx = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
        });
        await hydrate.execute({ profileId: 'baseline' }, ctx);

        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        expect(state!.policySnapshot.maxSelfReviewIterations).toBe(5);
        expect(state!.policySnapshot.maxImplReviewIterations).toBe(7);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('new session persists config requireVerifiedActorsForApproval in policySnapshot', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p33-verified-');
      try {
        const {
          computeFingerprint,
          workspaceDir,
          sessionDir: resolveSessionDir,
        } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');
        const { readState } = await import('../adapters/persistence.js');
        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);

        const baseConfig = await readConfig(wsDir);
        await writeConfig(wsDir, {
          ...baseConfig,
          policy: {
            ...baseConfig.policy,
            requireVerifiedActorsForApproval: true,
          },
        });

        const localCtx = createToolContext({
          worktree: tmpDir,
          directory: tmpDir,
          sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
        });
        await hydrate.execute({ profileId: 'baseline' }, localCtx);

        const sessDir = resolveSessionDir(fp.fingerprint, localCtx.sessionID);
        const state = await readState(sessDir);
        expect(state!.policySnapshot.requireVerifiedActorsForApproval).toBe(true);
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('explicit profileId=unknown blocks with INVALID_PROFILE', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p31-d-');
      try {
        const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);

        // Set up any config (not needed for explicit override)
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');
        const config = await readConfig(wsDir);
        await writeConfig(wsDir, { ...config });

        // Explicit unknown profile should fail
        const result = parseToolResult(
          await hydrate.execute(
            { profileId: 'nonexistent-profile-xyz' },
            createToolContext({
              worktree: tmpDir,
              directory: tmpDir,
              sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
            }),
          ),
        );
        expect(result.error).toBe(true);
        expect(result.code).toBe('INVALID_PROFILE');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('config.profile.defaultId=unknown blocks with INVALID_PROFILE', async () => {
      const tmpDir = await fs.mkdtemp('/tmp/p31-c-');
      try {
        const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
        const { writeConfig, readConfig } = await import('../adapters/persistence.js');
        const fp = await computeFingerprint(tmpDir);
        const wsDir = workspaceDir(fp.fingerprint);
        const baseConfig = await readConfig(wsDir);
        await writeConfig(wsDir, {
          ...baseConfig,
          profile: { ...baseConfig.profile, defaultId: 'nonexistent-profile-xyz' },
        });
        const result = parseToolResult(
          await hydrate.execute(
            {},
            createToolContext({
              worktree: tmpDir,
              directory: tmpDir,
              sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
            }),
          ),
        );
        expect(result.error).toBe(true);
        expect(result.code).toBe('INVALID_PROFILE');
      } finally {
        await fs.rm(tmpDir, { recursive: true, force: true });
      }
    });

    it('config.profile.activeChecks overrides selected profile defaults', async () => {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);

      // Write config with custom activeChecks
      const baseConfig = await readConfig(wsDir);
      await writeConfig(wsDir, {
        ...baseConfig,
        profile: {
          ...baseConfig.profile,
          defaultId: 'typescript',
          activeChecks: ['custom_check_a', 'custom_check_b'],
        },
      });

      // New session uses config activeChecks, not profile defaults
      const ctx2 = createToolContext({
        worktree: ws.tmpDir,
        directory: ws.tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });
      await hydrate.execute({ profileId: 'typescript' }, ctx2);

      // Read from workspace profile-resolution.json (not from session snapshot)
      const fs = await import('node:fs/promises');
      const prPath = `${wsDir}/discovery/profile-resolution.json`;
      const pr = JSON.parse(await fs.readFile(prPath, 'utf-8'));
      expect(pr.activeChecks).toEqual(['custom_check_a', 'custom_check_b']);
    });

    // Note: policy iteration limits from config are tested in config.test.ts (unit tests)
    // New-session test above proves config values are persisted in snapshot
  });

  it('existing session keeps snapshot values despite changed config', async () => {
    const tmpDir = await fs.mkdtemp('/tmp/p31-existing-');
    try {
      const {
        computeFingerprint,
        workspaceDir,
        sessionDir: resolveSessionDir,
      } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');

      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const ctxExisting = createToolContext({
        worktree: tmpDir,
        directory: tmpDir,
        sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
      });

      // First hydrate with explicit config limits
      const config1 = await readConfig(wsDir);
      await writeConfig(wsDir, {
        ...config1,
        policy: { ...config1.policy, maxSelfReviewIterations: 2 },
      });
      await hydrate.execute({}, ctxExisting);

      const sessDir = resolveSessionDir(fp.fingerprint, ctxExisting.sessionID);
      const before = await readState(sessDir);
      expect(before).not.toBeNull();
      expect(before!.policySnapshot.maxSelfReviewIterations).toBe(2);

      // Change config and re-hydrate same session
      const config2 = await readConfig(wsDir);
      await writeConfig(wsDir, {
        ...config2,
        policy: { ...config2.policy, maxSelfReviewIterations: 5 },
      });
      await hydrate.execute({}, ctxExisting);

      const after = await readState(sessDir);
      expect(after).not.toBeNull();
      expect(after!.policySnapshot.maxSelfReviewIterations).toBe(2);
      expect(after!.policySnapshot.maxSelfReviewIterations).not.toBe(5);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  // ── P27: Actor Identity ──────────────────────────────────────────────────
  describe('P27 Actor Identity', () => {
    it('hydrate stores actorInfo in session state', async () => {
      const result = await hydrateSession();
      expect(result.phase).toBe('READY');

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.actorInfo).toEqual({
        id: 'test-operator',
        email: 'test@flowguard.dev',
        source: 'env',
      });
    });

    it('actorInfo persisted at hydrate is reused even if env changes', async () => {
      // First hydrate with default mock actor
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state1 = await readState(sessDir);
      expect(state1!.actorInfo).toEqual({
        id: 'test-operator',
        email: 'test@flowguard.dev',
        source: 'env',
      });

      // Change actor mock — simulates env change mid-session
      vi.mocked(actorMock.resolveActor).mockResolvedValue({
        id: 'changed-operator',
        email: 'changed@flowguard.dev',
        source: 'env',
      });

      // Re-hydrate — should return existing state unchanged (idempotent)
      const result = await hydrateSession();
      expect(result.phase).toBe('READY');
      const state2 = await readState(sessDir);
      // Actor should be the original value, NOT the changed one
      expect(state2!.actorInfo).toEqual({
        id: 'test-operator',
        email: 'test@flowguard.dev',
        source: 'env',
      });
    });

    it('audit lifecycle event contains actorInfo after hydrate', async () => {
      // Note: In integration tests, tools are called directly (not through plugin
      // wrapper that emits audit events). Verify actorInfo is wired to the state
      // which the plugin uses: state.actorInfo is passed to createLifecycleEvent.
      // Factory-level audit event tests are in audit.test.ts (P27 section).
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      // Verify the actorInfo that plugin.ts would use for audit events
      expect(state!.actorInfo).toBeDefined();
      expect(state!.actorInfo!.id).toBe('test-operator');
      expect(state!.actorInfo!.source).toBe('env');
    });

    it('sessionID is still present separately from actorInfo in state', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      // sessionID lives in binding, actorInfo is separate
      expect(state!.binding.sessionId).toBe(ctx.sessionID);
      expect(state!.actorInfo).toBeDefined();
      expect(state!.initiatedBy).toBe(state!.actorInfo!.id);
      expect(state!.binding.sessionId).not.toBe(state!.actorInfo!.id);
      expect(state!.binding.sessionId).not.toBe(state!.initiatedBy);
    });
  });
});

// =============================================================================
// Tool 3: ticket
// =============================================================================

describe('ticket', () => {
  describe('HAPPY', () => {
    it('records ticket text and stays in TICKET phase', async () => {
      await hydrateSession();
      const raw = await ticket.execute({ text: 'Fix the auth bug', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('TICKET');
      expect(result.status).toBe('ok');
    });

    it('ticket is persisted in state on disk', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'Fix login flow', source: 'user' }, ctx);
      // Read state directly from disk
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket).not.toBeNull();
      expect(state!.ticket!.text).toBe('Fix login flow');
    });
  });

  describe('BAD', () => {
    it('blocks with EMPTY_TICKET for empty text', async () => {
      await hydrateSession();
      const raw = await ticket.execute({ text: '', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EMPTY_TICKET');
    });

    it('blocks with NO_SESSION when no session exists', async () => {
      const raw = await ticket.execute({ text: 'Something', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('re-ticketing in TICKET phase replaces ticket text', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'First ticket', source: 'user' }, ctx);
      await ticket.execute({ text: 'Second ticket', source: 'user' }, ctx);
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket!.text).toBe('Second ticket');
    });

    it('re-ticketing from non-TICKET phase is blocked', async () => {
      await hydrateAndTicket('First ticket');
      // Submit plan → phase advances from TICKET
      await plan.execute({ planText: '## Plan\n1. Do stuff' }, ctx);
      // Re-ticket should be blocked (not in TICKET phase)
      const raw = await ticket.execute({ text: 'Second ticket', source: 'user' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  describe('EDGE', () => {
    it('accepts external source', async () => {
      await hydrateSession();
      const raw = await ticket.execute({ text: 'JIRA-1234: Fix bug', source: 'external' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });
  });
});

// =============================================================================
// Tool 4: plan
// =============================================================================

describe('plan', () => {
  describe('HAPPY', () => {
    it('Mode A: records initial plan with digest', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute({ planText: '## Plan\n1. Fix auth\n2. Add tests' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.planDigest).toBeTruthy();
      expect(result.selfReviewIteration).toBe(0);
    });

    it('Mode B: approve converges self-review', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
      const raw = await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      // In solo mode, max iterations is 1, so should converge
      expect(
        result.converged === true ||
          result.phase === 'PLAN_REVIEW' ||
          result.phase === 'VALIDATION',
      ).toBe(true);
    });

    it('Mode B: changes_requested with revised plan', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Original Plan' }, ctx);
      const raw = await plan.execute(
        {
          selfReviewVerdict: 'changes_requested',
          planText: '## Revised Plan\n1. Better approach',
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });
  });

  describe('BAD', () => {
    it('blocks with EMPTY_PLAN for empty planText', async () => {
      await hydrateAndTicket();
      const raw = await plan.execute({ planText: '' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EMPTY_PLAN');
    });

    it('blocks in READY phase (command not allowed without ticket phase)', async () => {
      await hydrateSession();
      const raw = await plan.execute({ planText: '## Plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('blocks without session', async () => {
      const raw = await plan.execute({ planText: '## Plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('Mode B changes_requested requires revised planText', async () => {
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan' }, ctx);
      const raw = await plan.execute({ selfReviewVerdict: 'changes_requested' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVISED_PLAN_REQUIRED');
    });
  });
});

// =============================================================================
// Tool 5: decision (review-decision)
// =============================================================================

describe('decision', () => {
  /** Helper: get to PLAN_REVIEW phase (solo auto-converges self-review). */
  async function reachPlanReview(): Promise<void> {
    await hydrateSession({ policyMode: 'team' });
    await ticket.execute({ text: 'Fix bug', source: 'user' }, ctx);
    await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
    // In team mode, we need to manually approve self-review
    // Keep approving until convergence
    for (let i = 0; i < 5; i++) {
      const s = parseToolResult(await status.execute({}, ctx));
      if (s.phase === 'PLAN_REVIEW') break;
      await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
    }
  }

  describe('HAPPY', () => {
    it('approve at PLAN_REVIEW advances to VALIDATION', async () => {
      await reachPlanReview();
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('VALIDATION');
    });
  });

  describe('BAD', () => {
    it('blocks at wrong phase', async () => {
      await hydrateSession();
      const raw = await decision.execute({ verdict: 'approve', rationale: '' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('blocks without session', async () => {
      const raw = await decision.execute({ verdict: 'approve', rationale: '' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('fail-closes when derived plan artifacts are missing', async () => {
      await reachPlanReview();

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      await fs.rm(`${sessDir}/artifacts`, { recursive: true, force: true });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EVIDENCE_ARTIFACT_MISSING');
    });

    it('maps actor claim expiration to structured decision errors', async () => {
      const { ActorClaimError } = actorMock;
      await reachPlanReview();
      vi.mocked(actorMock.resolveActor).mockRejectedValueOnce(
        new ActorClaimError('ACTOR_CLAIM_EXPIRED', 'claim expired'),
      );

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('ACTOR_CLAIM_EXPIRED');
    });
  });

  describe('CORNER', () => {
    it('reject at PLAN_REVIEW returns to TICKET', async () => {
      await reachPlanReview();
      const raw = await decision.execute({ verdict: 'reject', rationale: 'Need rethink' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('TICKET');
    });

    it('changes_requested at PLAN_REVIEW returns to PLAN', async () => {
      await reachPlanReview();
      const raw = await decision.execute(
        { verdict: 'changes_requested', rationale: 'More detail needed' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');
    });

    it('config verified-actor requirement blocks approve for best_effort reviewer', async () => {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeConfig, readConfig } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(wsDir);
      await writeConfig(wsDir, {
        ...baseConfig,
        policy: {
          ...baseConfig.policy,
          requireVerifiedActorsForApproval: true,
        },
      });

      await reachPlanReview();
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Looks good' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('VERIFIED_ACTOR_REQUIRED');
    });
  });
});

// =============================================================================
// P26: Regulated Archive Completion Semantics
// =============================================================================

describe('P26: regulated archive completion', () => {
  /**
   * Build a regulated EVIDENCE_REVIEW state deterministically.
   *
   * Uses direct state write with fixture evidence instead of walking the full
   * workflow. The P26 tests verify the EVIDENCE_REVIEW → COMPLETE archive
   * boundary — the workflow walk is covered by e2e-workflow.test.ts.
   *
   * Returns the session directory for post-assertion state reads.
   */
  async function reachRegulatedEvidenceReview(): Promise<string> {
    // 1. Hydrate to set up workspace + session directory
    await hydrateSession({ policyMode: 'team' });
    const { computeFingerprint, sessionDir: resolveSessionDir } = wsMock;
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);

    // 2. Read hydrated state for session identity + binding
    const baseState = await readState(sessDir);
    expect(baseState).not.toBeNull();

    // 3. Write EVIDENCE_REVIEW state with regulated policy + fixture evidence.
    //    Uses writeStateWithArtifacts to materialize ticket/plan artifacts
    //    (required by requireStateForMutation's verifyEvidenceArtifacts).
    const regulatedState = {
      ...baseState!,
      phase: 'EVIDENCE_REVIEW' as const,
      ticket: TICKET,
      plan: PLAN_RECORD,
      selfReview: SELF_REVIEW_CONVERGED,
      reviewDecision: {
        ...REVIEW_APPROVE,
        decisionIdentity: {
          actorId: 'reviewer',
          actorEmail: 'reviewer@test.com',
          actorSource: 'env' as const,
          actorAssurance: 'best_effort' as const,
        },
      },
      validation: VALIDATION_PASSED,
      implementation: IMPL_EVIDENCE,
      implReview: IMPL_REVIEW_CONVERGED,
      initiatedBy: 'initiator',
      initiatedByIdentity: {
        actorId: 'initiator',
        actorEmail: 'initiator@test.com',
        actorSource: 'env' as const,
        actorAssurance: 'best_effort' as const,
      },
      policySnapshot: {
        ...baseState!.policySnapshot,
        mode: 'regulated' as const,
        requestedMode: 'regulated',
        allowSelfApproval: false,
        requireHumanGates: true,
        audit: {
          ...baseState!.policySnapshot.audit,
          enableChainHash: true,
        },
      },
      error: null,
    };
    await writeStateWithArtifacts(sessDir, regulatedState);
    return sessDir;
  }

  describe('HAPPY', () => {
    it('regulated + archive success + verify pass → archiveStatus: verified', async () => {
      const sessDir = await reachRegulatedEvidenceReview();
      vi.mocked(wsMock.archiveSession).mockResolvedValueOnce('/fake/archive.tar.gz');
      vi.mocked(wsMock.verifyArchive).mockResolvedValueOnce({
        passed: true,
        findings: [],
        manifest: null,
        verifiedAt: new Date().toISOString(),
      });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      // Response must surface archiveStatus — agent/user must see clean completion
      expect(result.archiveStatus).toBe('verified');

      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.archiveStatus).toBe('verified');
    });
  });

  describe('BAD', () => {
    it('regulated + archive creation throws → archiveStatus: failed', async () => {
      const sessDir = await reachRegulatedEvidenceReview();
      vi.mocked(wsMock.archiveSession).mockRejectedValueOnce(new Error('tar command failed'));

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      // Response must surface failure — agent/user must NOT see clean completion
      expect(result.archiveStatus).toBe('failed');

      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.archiveStatus).toBe('failed');
    });

    it('regulated + archive ok + verify fails → archiveStatus: failed', async () => {
      const sessDir = await reachRegulatedEvidenceReview();
      vi.mocked(wsMock.archiveSession).mockResolvedValueOnce('/fake/archive.tar.gz');
      vi.mocked(wsMock.verifyArchive).mockResolvedValueOnce({
        passed: false,
        findings: [
          {
            code: 'archive_checksum_mismatch',
            severity: 'error',
            message: 'Checksum mismatch',
          },
        ],
        manifest: null,
        verifiedAt: new Date().toISOString(),
      });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      // Response must surface failure — agent/user must NOT see clean completion
      expect(result.archiveStatus).toBe('failed');

      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.archiveStatus).toBe('failed');
    });
  });

  describe('CORNER', () => {
    it('team + clean completion → no archiveStatus (backward-compatible)', async () => {
      // Use team workflow directly (no regulated patch)
      await hydrateSession({ policyMode: 'team' });
      await ticket.execute({ text: 'Team task', source: 'user' }, ctx);
      await plan.execute({ planText: '## Plan\n1. Fix' }, ctx);
      for (let i = 0; i < 5; i++) {
        const s = parseToolResult(await status.execute({}, ctx));
        if (s.phase === 'PLAN_REVIEW') break;
        await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
      }
      await decision.execute({ verdict: 'approve', rationale: 'OK' }, ctx);
      await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        ctx,
      );
      await implement.execute({}, ctx);
      for (let i = 0; i < 5; i++) {
        const s = parseToolResult(await status.execute({}, ctx));
        if (s.phase === 'EVIDENCE_REVIEW') break;
        await implement.execute({ reviewVerdict: 'approve' }, ctx);
      }
      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      // Non-regulated: response must NOT include archiveStatus
      expect(result.archiveStatus).toBeUndefined();

      // Read state — archiveStatus should NOT be set
      const { computeFingerprint, sessionDir: resolveSessionDir } = wsMock;
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.archiveStatus).toBeUndefined();
    });

    it('solo + completion → no archiveStatus', async () => {
      // Solo auto-approves at gates — simple workflow
      await hydrateAndTicket();
      await plan.execute({ planText: '## Plan\n1. Fix auth' }, ctx);
      await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
      await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        ctx,
      );
      await implement.execute({}, ctx);
      await implement.execute({ reviewVerdict: 'approve' }, ctx);

      // Verify we're at COMPLETE (solo auto-approves EVIDENCE_REVIEW)
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.phase).toBe('COMPLETE');

      const { computeFingerprint, sessionDir: resolveSessionDir } = wsMock;
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.archiveStatus).toBeUndefined();
    });

    it('abort at regulated session → no archiveStatus (emergency escape)', async () => {
      // Hydrate with team mode and patch to regulated
      await hydrateSession({ policyMode: 'team' });
      const { computeFingerprint, sessionDir: resolveSessionDir } = wsMock;
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      await writeState(sessDir, {
        ...state!,
        policySnapshot: {
          ...state!.policySnapshot,
          mode: 'regulated',
          requestedMode: 'regulated',
          allowSelfApproval: false,
          requireHumanGates: true,
        },
      });

      // Abort → COMPLETE with error
      const raw = await abort_session.execute({ reason: 'Emergency' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');

      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.error).not.toBeNull();
      expect(finalState!.error!.code).toBe('ABORTED');
      // No archive attempt for aborted sessions
      expect(finalState!.archiveStatus).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('regulated + verify throws → archiveStatus: failed (fail-closed)', async () => {
      const sessDir = await reachRegulatedEvidenceReview();
      vi.mocked(wsMock.archiveSession).mockResolvedValueOnce('/fake/archive.tar.gz');
      vi.mocked(wsMock.verifyArchive).mockRejectedValueOnce(new Error('Verification I/O error'));

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      // Response must surface failure — fail-closed on verify exception
      expect(result.archiveStatus).toBe('failed');

      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.archiveStatus).toBe('failed');
    });

    it('regulated COMPLETE + archiveStatus !== verified is not clean completion', async () => {
      // Structural invariant test: regulated + failed archive = degraded terminal
      const sessDir = await reachRegulatedEvidenceReview();
      vi.mocked(wsMock.archiveSession).mockRejectedValueOnce(new Error('tar failed'));

      await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);

      const finalState = await readState(sessDir);
      expect(finalState).not.toBeNull();
      expect(finalState!.phase).toBe('COMPLETE');
      expect(finalState!.policySnapshot.mode).toBe('regulated');
      expect(finalState!.error).toBeNull();
      expect(finalState!.archiveStatus).not.toBe('verified');
      // This combination means: regulated session completed but archive failed.
      // Doctor/status tools should surface this as degraded completion.
    });

    it('session_completed audit event is appended BEFORE archiveSession is called', async () => {
      // P26 Review 3 blocker: the archive must contain the terminal lifecycle event.
      // Verifies call ordering: appendAuditEvent(session_completed) → archiveSession.
      await reachRegulatedEvidenceReview();

      const callOrder: string[] = [];
      const appendSpy = vi
        .spyOn(persistence, 'appendAuditEvent')
        .mockImplementation(async (_sessDir, event) => {
          // Track lifecycle completion events
          const detail = (event as Record<string, unknown>).detail as
            | Record<string, unknown>
            | undefined;
          if (detail?.action === 'session_completed') {
            callOrder.push('session_completed');
          }
        });
      vi.mocked(wsMock.archiveSession).mockImplementationOnce(async () => {
        callOrder.push('archiveSession');
        return '/fake/archive.tar.gz';
      });
      vi.mocked(wsMock.verifyArchive).mockResolvedValueOnce({
        passed: true,
        findings: [],
        manifest: null,
        verifiedAt: new Date().toISOString(),
      });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');

      // session_completed MUST appear before archiveSession in call order
      const completedIdx = callOrder.indexOf('session_completed');
      const archiveIdx = callOrder.indexOf('archiveSession');
      expect(completedIdx).toBeGreaterThanOrEqual(0);
      expect(archiveIdx).toBeGreaterThanOrEqual(0);
      expect(completedIdx).toBeLessThan(archiveIdx);

      appendSpy.mockRestore();
    });

    it('regulated audit trail contains exactly one session_completed event', async () => {
      // P26 Review 3: the tool-layer emits session_completed to the audit trail.
      // Verifies: (a) the event exists on disk, (b) there is exactly one (no duplication).
      // The plugin is not running in tool-execute tests, so this proves the tool-layer
      // writes the event and sets archiveStatus (which the plugin uses to skip its own).
      const sessDir = await reachRegulatedEvidenceReview();
      vi.mocked(wsMock.archiveSession).mockResolvedValueOnce('/fake/archive.tar.gz');
      vi.mocked(wsMock.verifyArchive).mockResolvedValueOnce({
        passed: true,
        findings: [],
        manifest: null,
        verifiedAt: new Date().toISOString(),
      });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      expect(result.archiveStatus).toBe('verified');

      // Read the actual audit trail from disk
      const { events } = await readAuditTrail(sessDir);
      const completionEvents = events.filter((e) => e.event === 'lifecycle:session_completed');
      // Exactly one session_completed — tool-layer wrote it, no duplication
      expect(completionEvents).toHaveLength(1);
      expect(completionEvents[0]!.actor).toBe('machine');
      expect(completionEvents[0]!.sessionId).toBe(ctx.sessionID);

      // archiveStatus on persisted state enables plugin to skip its own emission
      const finalState = await readState(sessDir);
      expect(finalState!.archiveStatus).toBe('verified');
    });

    it('regulated + session_completed append fails → archiveStatus: failed', async () => {
      // P26 Review 5: audit emission is part of the fail-closed finalization chain.
      // If appendAuditEvent throws, the entire chain fails — no "verified archive
      // without session_completed" can exist.
      const sessDir = await reachRegulatedEvidenceReview();
      const appendSpy = vi
        .spyOn(persistence, 'appendAuditEvent')
        .mockRejectedValueOnce(new Error('Audit write I/O failure'));
      // archiveSession/verifyArchive are NOT mocked here — they must not be
      // reached when audit emission fails (fail-closed short-circuit).

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
      // Must be failed — audit append failure blocks verified archive
      expect(result.archiveStatus).toBe('failed');

      const finalState = await readState(sessDir);
      expect(finalState!.archiveStatus).toBe('failed');

      appendSpy.mockRestore();
    });

    it('archiveSession is not called when session_completed append fails', async () => {
      // P26 Review 5: proves archiveSession is never reached when audit emission
      // fails. The single try/catch ensures audit → archive → verify is atomic.
      await reachRegulatedEvidenceReview();
      const appendSpy = vi
        .spyOn(persistence, 'appendAuditEvent')
        .mockRejectedValueOnce(new Error('Disk full'));
      const archiveSpy = vi.mocked(wsMock.archiveSession);

      await decision.execute({ verdict: 'approve', rationale: 'Ship it' }, ctx);

      // archiveSession must NOT have been called — audit failure short-circuits
      expect(archiveSpy).not.toHaveBeenCalled();

      appendSpy.mockRestore();
    });
  });
});

// =============================================================================
// Tool 6: implement
// =============================================================================

describe('implement', () => {
  /** Helper: reach IMPLEMENTATION phase via solo workflow. */
  async function reachImplementation(): Promise<void> {
    await hydrateAndTicket();
    await plan.execute({ planText: '## Plan\n1. Fix auth' }, ctx);
    // Solo: self-review auto-converges at max=1
    await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
    // Solo: PLAN_REVIEW auto-approves → VALIDATION
    // Submit validation results
    await validate.execute(
      {
        results: [
          { checkId: 'test_quality', passed: true, detail: 'OK' },
          { checkId: 'rollback_safety', passed: true, detail: 'OK' },
        ],
      },
      ctx,
    );
  }

  describe('HAPPY', () => {
    it('Mode A: records changed files from git', async () => {
      await reachImplementation();
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.changedFiles).toBeDefined();
      expect(result.domainFiles).toBeDefined();
    });

    it('Mode B: approve review converges in solo', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      const raw = await implement.execute({ reviewVerdict: 'approve' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(
        result.converged === true ||
          result.phase === 'EVIDENCE_REVIEW' ||
          result.phase === 'COMPLETE',
      ).toBe(true);
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('blocks without plan/ticket', async () => {
      await hydrateSession();
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
    });
  });

  describe('CORNER', () => {
    it('filters out .opencode/ files from domain files', async () => {
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'src/foo.ts',
        '.opencode/tools/flowguard.ts',
        'node_modules/dep/index.js',
      ]);
      await reachImplementation();
      const raw = await implement.execute({}, ctx);
      const result = parseToolResult(raw);
      const domain = result.domainFiles as string[];
      expect(domain).toContain('src/foo.ts');
      expect(domain).not.toContain('.opencode/tools/flowguard.ts');
      expect(domain).not.toContain('node_modules/dep/index.js');
    });
  });
});

// =============================================================================
// Tool 7: validate
// =============================================================================

describe('validate', () => {
  /** Helper: reach VALIDATION phase. */
  async function reachValidation(): Promise<void> {
    await hydrateAndTicket();
    await plan.execute({ planText: '## Plan' }, ctx);
    await plan.execute({ selfReviewVerdict: 'approve' }, ctx);
    // Solo: auto-advances to VALIDATION
  }

  describe('HAPPY', () => {
    it('ALL_PASSED advances to IMPLEMENTATION', async () => {
      await reachValidation();
      const raw = await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('IMPLEMENTATION');
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await validate.execute(
        {
          results: [{ checkId: 'test_quality', passed: true, detail: 'OK' }],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('CHECK_FAILED returns to PLAN', async () => {
      await reachValidation();
      const raw = await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: false, detail: 'Missing tests' },
            { checkId: 'rollback_safety', passed: true, detail: 'OK' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('PLAN');
    });

    it('blocks when required checks are missing', async () => {
      await reachValidation();
      const raw = await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'OK' },
            // Missing rollback_safety
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('MISSING_CHECKS');
    });

    it('results are persisted in state', async () => {
      await reachValidation();
      await validate.execute(
        {
          results: [
            { checkId: 'test_quality', passed: true, detail: 'Tests pass' },
            { checkId: 'rollback_safety', passed: true, detail: 'Safe' },
          ],
        },
        ctx,
      );
      const s = parseToolResult(await status.execute({}, ctx));
      const vr = s.validationResults as Array<{ checkId: string; passed: boolean }>;
      expect(vr).toHaveLength(2);
      expect(vr[0].passed).toBe(true);
    });
  });
});

// =============================================================================
// Tool 8: review
// =============================================================================

describe('review', () => {
  describe('HAPPY', () => {
    it('starts review flow from READY and transitions to REVIEW_COMPLETE', async () => {
      await hydrateSession();
      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('REVIEW_COMPLETE');
      expect(result.completeness).toBeDefined();
    });

    it('report includes completeness matrix', async () => {
      await hydrateSession();
      const result = parseToolResult(await review.execute({}, ctx));
      const comp = result.completeness as Record<string, unknown>;
      expect(typeof comp.overallComplete).toBe('boolean');
      expect(comp.slots).toBeDefined();
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('blocks when not in READY phase', async () => {
      await hydrateAndTicket();
      const raw = await review.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });
  });

  describe('CORNER', () => {
    it('review flow persists REVIEW_COMPLETE phase on disk', async () => {
      await hydrateSession();
      await review.execute({}, ctx);
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.phase).toBe('REVIEW_COMPLETE');
    });
  });
});

// =============================================================================
// Tool 9: abort_session
// =============================================================================

describe('abort_session', () => {
  describe('HAPPY', () => {
    it('aborts session to COMPLETE', async () => {
      await hydrateAndTicket();
      const raw = await abort_session.execute({ reason: 'Testing abort' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('COMPLETE');
    });

    it('abort is persisted on disk', async () => {
      await hydrateSession();
      await abort_session.execute({ reason: 'Done' }, ctx);
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.phase).toBe('COMPLETE');
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await abort_session.execute({ reason: 'No session' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });
  });

  describe('CORNER', () => {
    it('can abort from any non-terminal phase', async () => {
      // Abort from READY phase (after hydrate)
      await hydrateSession();
      const raw = await abort_session.execute({ reason: 'Cancel' }, ctx);
      const result = parseToolResult(raw);
      expect(result.phase).toBe('COMPLETE');
    });
  });
});

// =============================================================================
// Tool 10: archive
// =============================================================================

describe('archive', () => {
  describe('HAPPY', () => {
    it.skipIf(!tarOk)('archives a completed session to tar.gz', async () => {
      await hydrateSession();
      await abort_session.execute({ reason: 'Complete for archive' }, ctx);
      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.status).toContain('archived');
      expect(typeof result.archivePath).toBe('string');
      // Verify tar.gz file exists on disk
      await expect(fs.access(result.archivePath as string)).resolves.toBeUndefined();
    });

    it.skipIf(!tarOk)(
      'archive manifest includes derived ticket/plan artifacts with digests',
      async () => {
        await hydrateSession();
        await ticket.execute({ text: 'Archive artifact evidence test', source: 'user' }, ctx);
        await plan.execute({ planText: '## Plan\n1. Create evidence artifacts' }, ctx);

        const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
          '../adapters/workspace/index.js'
        );
        const fp = await computeFingerprint(ws.tmpDir);
        const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
        const state = await readState(sessDir);
        await writeState(sessDir, { ...state!, phase: 'COMPLETE' });

        const raw = await archive.execute({}, ctx);
        const result = parseToolResult(raw);
        expect(result.error).toBeUndefined();

        const manifestRaw = await fs.readFile(`${sessDir}/archive-manifest.json`, 'utf-8');
        const manifest = JSON.parse(manifestRaw) as {
          includedFiles: string[];
          fileDigests: Record<string, string>;
        };
        expect(manifest.includedFiles).toContain('artifacts/ticket.v1.md');
        expect(manifest.includedFiles).toContain('artifacts/ticket.v1.json');
        expect(manifest.includedFiles).toContain('artifacts/plan.v1.md');
        expect(manifest.includedFiles).toContain('artifacts/plan.v1.json');
        expect(manifest.fileDigests['artifacts/ticket.v1.json']).toBeTruthy();
        expect(manifest.fileDigests['artifacts/plan.v1.json']).toBeTruthy();
      },
    );
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('blocks when session is not in a terminal phase', async () => {
      await hydrateSession();
      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('COMMAND_NOT_ALLOWED');
    });

    it('fail-closes archive when state references plan but derived artifacts are missing', async () => {
      await hydrateSession();
      await ticket.execute({ text: 'Archive guard ticket', source: 'user' }, ctx);
      await plan.execute({ planText: '## Plan\n1. Archive guard plan' }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, { ...state!, phase: 'COMPLETE' });

      await fs.rm(`${sessDir}/artifacts`, { recursive: true, force: true });

      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect([
        'ARCHIVE_FAILED',
        'EVIDENCE_ARTIFACT_MISSING',
        'EVIDENCE_ARTIFACT_MISMATCH',
      ]).toContain(result.code);
    });
  });

  describe('CORNER', () => {
    it.skipIf(!tarOk)('archives from ARCH_COMPLETE', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        phase: 'ARCH_COMPLETE',
        architecture: {
          id: 'ADR-1',
          title: 'Test ADR',
          adrText: '## Context\nTest\n## Decision\nTest\n## Consequences\nTest',
          status: 'accepted',
          createdAt: new Date().toISOString(),
          digest: 'abc123',
        },
      });
      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.status).toContain('archived');
    });

    it.skipIf(!tarOk)('archives from REVIEW_COMPLETE', async () => {
      await hydrateSession();
      const { computeFingerprint, sessionDir: resolveSessionDir } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, { ...state!, phase: 'REVIEW_COMPLETE' });
      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.status).toContain('archived');
    });

    it('archive path follows expected pattern', async () => {
      await hydrateSession();
      await abort_session.execute({ reason: 'Done' }, ctx);
      // Even if tar is missing, the tool should at least try and produce
      // a meaningful error or succeed. We test the path structure.
      const raw = await archive.execute({}, ctx);
      const result = parseToolResult(raw);
      if (!result.error) {
        expect(result.archivePath).toContain('sessions');
        expect(result.archivePath).toContain('archive');
        expect((result.archivePath as string).endsWith('.tar.gz')).toBe(true);
      } else {
        // If tar failed, we get ARCHIVE_FAILED — that's acceptable
        expect(result.code).toBe('ARCHIVE_FAILED');
      }
    });
  });
});

// =============================================================================
// Cross-cutting
// =============================================================================

describe('cross-cutting', () => {
  describe('EDGE', () => {
    it('repo without remote uses path-based fingerprint', async () => {
      vi.mocked(gitMock.remoteOriginUrl).mockResolvedValue(null);
      const result = await hydrateSession();
      expect(result.phase).toBe('READY');
      // Verify the full tool chain works with path fingerprint
      await ticket.execute({ text: 'Path-based test', source: 'user' }, ctx);
      const s = parseToolResult(await status.execute({}, ctx));
      expect(s.hasTicket).toBe(true);
    });

    it('idempotent hydrate on workspace level', async () => {
      // First hydrate
      await hydrateSession();
      const { computeFingerprint, readWorkspaceInfo } = await import(
        '../adapters/workspace/index.js'
      );
      const fp = await computeFingerprint(ws.tmpDir);
      const info1 = await readWorkspaceInfo(fp.fingerprint);

      // Second hydrate (same worktree, same sessionID)
      await hydrateSession();
      const info2 = await readWorkspaceInfo(fp.fingerprint);

      // Workspace metadata should not be corrupted
      expect(info2!.fingerprint).toBe(info1!.fingerprint);
      expect(info2!.materialClass).toBe(info1!.materialClass);
    });
  });

  describe('PERF', () => {
    it('50x status calls complete in reasonable time', async () => {
      await hydrateSession();
      const start = performance.now();
      for (let i = 0; i < 50; i++) {
        await status.execute({}, ctx);
      }
      const elapsed = performance.now() - start;
      // 50 calls with real FS I/O — generous budget of 10s
      expect(elapsed).toBeLessThan(10_000);
    });
  });
});
