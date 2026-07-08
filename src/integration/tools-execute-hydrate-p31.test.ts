/**
 * @module integration/tools-execute-hydrate-p31.test
 * @description P31 Config-as-Runtime-Authority hydrate execution tests.
 *              Tests hydrate.execute() with tempdir-backed config resolution
 *              and direct invocation (no hydrateSession helper).
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import {
  createToolContext,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import { readState } from '../adapters/persistence.js';
import { hydrate } from './tools/index.js';
import { createTestWorkspace } from './test-helpers.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

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

async function rmWithRetry(dir: string, retries = 3): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await fs.rm(dir, { recursive: true, force: true });
      return;
    } catch {
      if (i === retries - 1) throw new Error(`Failed to clean up dir: ${dir}`);
      await new Promise((resolve) => setTimeout(resolve, 100 * (i + 1)));
    }
  }
}

let ws: TestWorkspace;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
  ws = await createTestWorkspace();
  try {
    await fs.rm(path.join(ws.tmpDir, '.opencode', 'flowguard.json'), { force: true });
  } catch {
    // No stale config
  }
});

afterEach(async () => {
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    });
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

describe('P31 Config as Runtime Authority', () => {
  it('config.profile.defaultId is used when no explicit profileId', async () => {
    const tmpDir = await fs.mkdtemp('/tmp/p31-a-');
    try {
      const {
        computeFingerprint,
        workspaceDir,
        sessionDir: resolveSessionDir,
      } = await import('../adapters/workspace/index.js');
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(tmpDir);
      await writeRepoConfig(tmpDir, {
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
      await rmWithRetry(tmpDir);
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
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');

      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(tmpDir);
      // Set config default to baseline, then override explicitly to typescript.
      await writeRepoConfig(tmpDir, {
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
      await rmWithRetry(tmpDir);
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
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');

      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(tmpDir);
      // Set config default to typescript, but explicitly request baseline.
      await writeRepoConfig(tmpDir, {
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
      await rmWithRetry(tmpDir);
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
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const { readState } = await import('../adapters/persistence.js');

      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(tmpDir);
      await writeRepoConfig(tmpDir, { ...baseConfig });

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
      await rmWithRetry(tmpDir);
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
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const { readState } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);

      const baseConfig = await readConfig(tmpDir);
      await writeRepoConfig(tmpDir, {
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
      await rmWithRetry(tmpDir);
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
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const { readState } = await import('../adapters/persistence.js');
      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);

      const baseConfig = await readConfig(tmpDir);
      await writeRepoConfig(tmpDir, {
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
      await rmWithRetry(tmpDir);
    }
  });

  it('explicit profileId=unknown blocks with INVALID_PROFILE', async () => {
    const tmpDir = await fs.mkdtemp('/tmp/p31-d-');
    try {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);

      // Set up any config (not needed for explicit override)
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const config = await readConfig(tmpDir);
      await writeRepoConfig(tmpDir, { ...config });

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
      await rmWithRetry(tmpDir);
    }
  });

  it('config.profile.defaultId=unknown blocks with INVALID_PROFILE', async () => {
    const tmpDir = await fs.mkdtemp('/tmp/p31-c-');
    try {
      const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
      const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
      const fp = await computeFingerprint(tmpDir);
      const wsDir = workspaceDir(fp.fingerprint);
      const baseConfig = await readConfig(tmpDir);
      await writeRepoConfig(tmpDir, {
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
      await rmWithRetry(tmpDir);
    }
  });

  it('config.profile.activeChecks overrides selected profile defaults', async () => {
    const { computeFingerprint, workspaceDir } = await import('../adapters/workspace/index.js');
    const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const wsDir = workspaceDir(fp.fingerprint);

    // Write config with custom activeChecks
    const baseConfig = await readConfig(ws.tmpDir);
    await writeRepoConfig(ws.tmpDir, {
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
    const { writeRepoConfig, readConfig } = await import('../adapters/persistence-config.js');

    const fp = await computeFingerprint(tmpDir);
    const wsDir = workspaceDir(fp.fingerprint);
    const ctxExisting = createToolContext({
      worktree: tmpDir,
      directory: tmpDir,
      sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
    });

    // First hydrate with explicit config limits
    const config1 = await readConfig(tmpDir);
    await writeRepoConfig(tmpDir, {
      ...config1,
      policy: { ...config1.policy, maxSelfReviewIterations: 2 },
    });
    await hydrate.execute({}, ctxExisting);

    const sessDir = resolveSessionDir(fp.fingerprint, ctxExisting.sessionID);
    const before = await readState(sessDir);
    expect(before).not.toBeNull();
    expect(before!.policySnapshot.maxSelfReviewIterations).toBe(2);

    // Change config and re-hydrate same session
    const config2 = await readConfig(tmpDir);
    await writeRepoConfig(tmpDir, {
      ...config2,
      policy: { ...config2.policy, maxSelfReviewIterations: 5 },
    });
    await hydrate.execute({}, ctxExisting);

    const after = await readState(sessDir);
    expect(after).not.toBeNull();
    expect(after!.policySnapshot.maxSelfReviewIterations).toBe(2);
    expect(after!.policySnapshot.maxSelfReviewIterations).not.toBe(5);
  } finally {
    await rmWithRetry(tmpDir);
  }
});
