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
} from './test-helpers';
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
} from './tools';
import { readState, writeState } from '../adapters/persistence';
import * as persistence from '../adapters/persistence';
import { makeState, makeProgressedState } from '../__fixtures__';
import { resolvePolicyFromState } from './tools/helpers';
import { TEAM_POLICY } from '../config/policy';

// ─── Git Mock ────────────────────────────────────────────────────────────────

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

// Lazy import for per-test overrides
const gitMock = await import('../adapters/git');

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
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helper ──────────────────────────────────────────────────────────────────

/** Hydrate a session and return parsed result. Convenience for setup. */
async function hydrateSession(
  overrides: { policyMode?: string; profileId?: string } = {},
): Promise<Record<string, unknown>> {
  const raw = await hydrate.execute(
    { policyMode: overrides.policyMode ?? 'solo', profileId: overrides.profileId ?? 'baseline' },
    ctx,
  );
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('READY');
      expect(state!.binding.fingerprint).toBe(fp.fingerprint);
    });

    it('auto-detects TypeScript profile from repo signals', async () => {
      const result = await hydrateSession({ profileId: 'baseline' });
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
      } = await import('../adapters/workspace');
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

      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace');
      const fp = await computeFingerprint(ws.tmpDir);
      const cfgPath = `${workspaceDir(fp.fingerprint)}/config.json`;
      await fs.writeFile(cfgPath, '{invalid{{{', 'utf-8');

      const result = await hydrateSession();
      expect(result.error).toBe(true);
      expect(result.code).toBe('WORKSPACE_CONFIG_INVALID');
      expect(result.message).toContain('invalid');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, readWorkspaceInfo } = await import('../adapters/workspace');
      const fp = await computeFingerprint(ws.tmpDir);
      const info = await readWorkspaceInfo(fp.fingerprint);
      expect(info).not.toBeNull();
      expect(info!.fingerprint).toBe(fp.fingerprint);
    });

    it('hydrate without explicit mode uses config.policy.defaultMode: regulated', async () => {
      // Enterprise blocker test: install intent must flow through to policySnapshot.
      // 1. Hydrate once to create workspace + session
      await hydrateSession({ policyMode: 'solo' });

      // 2. Write config with regulated as defaultMode
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace');
      const { writeConfig, readConfig } = await import('../adapters/persistence');
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
      const { sessionDir: resolveSessionDir } = await import('../adapters/workspace');
      const sessDir = resolveSessionDir(fp.fingerprint, ctx2.sessionID);
      const state = await readState(sessDir);
      expect(state).not.toBeNull();
      expect(state!.policySnapshot.mode).toBe('regulated');
    });

    it('hydrate with explicit mode overrides config default', async () => {
      // 1. Create workspace
      await hydrateSession({ policyMode: 'solo' });

      // 2. Set config default to regulated
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace');
      const { writeConfig, readConfig } = await import('../adapters/persistence');
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
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace');
      const { writeConfig, readConfig } = await import('../adapters/persistence');
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
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace');
      const fp = await computeFingerprint(ws.tmpDir);
      const cfgPath = `${workspaceDir(fp.fingerprint)}/config.json`;
      await fs.unlink(cfgPath);

      const result = await hydrateSession();
      expect(result.phase).toBe('READY');
      await expect(fs.access(cfgPath)).resolves.toBeUndefined();
    });

    it('fails closed when workspace config cannot be written', async () => {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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

    it('blocks without ticket', async () => {
      await hydrateSession();
      const raw = await plan.execute({ planText: '## Plan' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('TICKET_REQUIRED');
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

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      await fs.rm(`${sessDir}/artifacts`, { recursive: true, force: true });

      const raw = await decision.execute({ verdict: 'approve', rationale: 'Proceed' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('EVIDENCE_ARTIFACT_MISSING');
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

        const { computeFingerprint, sessionDir: resolveSessionDir } =
          await import('../adapters/workspace');
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

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace');
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
      const { computeFingerprint, readWorkspaceInfo } = await import('../adapters/workspace');
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
