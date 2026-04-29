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
  // Reset actor mock to default deterministic value (P27/P34)
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
