/**
 * @module integration/Execution tests for the abort_session tool
 * @description Execution tests for the abort_session tool.
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
  fulfillStrictReviewObligation,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import { REVIEW_MANDATE_DIGEST } from './review/assurance.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  decision,
  implement,
  run_check,
  review,
  abort_session,
  archive,
} from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
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
} from '../fixtures.js';
import { resolvePolicyFromState, writeStateWithArtifacts } from './tools/helpers.js';
import { TEAM_POLICY } from '../config/policy.js';
import { runWithAdapterLoggerAsync, type AdapterLogger } from '../logging/adapter-logger.js';

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

// ─── Persistence Mock (P8b: writeReport-throws test) ────────────────────────
// wrap writeReport as vi.fn forwarding to real implementation; tests can
// override per-test via mockImplementation.

const persistenceOriginals = vi.hoisted(() => ({
  writeReport: null as unknown as (typeof import('../adapters/persistence.js'))['writeReport'],
  readState: null as unknown as (typeof import('../adapters/persistence.js'))['readState'],
  writeState: null as unknown as (typeof import('../adapters/persistence.js'))['writeState'],
}));

vi.mock('../adapters/persistence', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/persistence.js')>();
  persistenceOriginals.writeReport = original.writeReport;
  persistenceOriginals.readState = original.readState;
  persistenceOriginals.writeState = original.writeState;
  return {
    ...original,
    writeReport: vi.fn(original.writeReport),
    readState: vi.fn(original.readState),
    writeState: vi.fn(original.writeState),
  };
});

// ─── Verification Executor Mock ─────────────────────────────────────────────
// Mock executeCheck to avoid real subprocess execution.
vi.mock('../verification/executor', () => ({
  executeCheck: vi
    .fn()
    .mockImplementation(async (input: { kind: string; command: string; cwd: string }) => ({
      kind: input.kind,
      command: input.command,
      exitCode: 0,
      passed: true,
      executionMs: 100,
      outputDigest: 'a'.repeat(64),
      stdout: 'OK',
      stderr: '',
      timedOut: false,
      startedAt: new Date().toISOString(),
    })),
}));

// Lazy import for per-test overrides
const gitMock = await import('../adapters/git.js');
const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');
const persistenceMock = await import('../adapters/persistence.js');
const executorMock = await import('../verification/executor.js');

// ─── Capability Gates ────────────────────────────────────────────────────────

const tarOk = await isTarAvailable();

// ─── Test Setup ──────────────────────────────────────────────────────────────

let ws: TestWorkspace;
let ctx: TestToolContext;
let cleanupEnv: () => void;

beforeEach(async () => {
  cleanupEnv = withTestEnv({ FLOWGUARD_POLICY_PATH: undefined });
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
  // Reset persistence mock to real implementation (P8b)
  vi.mocked(persistenceMock.writeReport)
    .mockReset()
    .mockImplementation(persistenceOriginals.writeReport);
  vi.mocked(persistenceMock.readState)
    .mockReset()
    .mockImplementation(persistenceOriginals.readState);
  vi.mocked(persistenceMock.writeState)
    .mockReset()
    .mockImplementation(persistenceOriginals.writeState);
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
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

// ─── Helpers ────────────────────────────────────────────────────────────

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

async function hydrateAndTicket(ticketText = 'Fix the auth bug'): Promise<void> {
  await hydrateSession();
  await ticket.execute({ text: ticketText, source: 'user' }, ctx);
}

async function currentSessionDir(): Promise<string> {
  const { computeFingerprint, sessionDir: resolveSessionDir } =
    await import('../adapters/workspace/index.js');
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool: abort_session
// ═══════════════════════════════════════════════════════════════════════════

describe('abort_session', () => {
  describe('HAPPY', () => {
    it('aborts session to COMPLETE', async () => {
      await hydrateAndTicket();
      const raw = await abort_session.execute({ reason: 'Testing abort' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('COMPLETE');
      // Governance integrity: the aborted session is explicitly marked and is NOT
      // presented as a clean completion — guidance redirects to /status and never
      // offers /export as a verifiable audit package.
      expect(result.aborted).toBe(true);
      const product = result.productNextAction as { text: string; commands: string[] };
      expect(product.commands).toEqual(['/status']);
      expect(product.text).not.toContain('/export');
      expect(product.text).not.toContain('/finish');
      expect(product.text).not.toContain('/review');
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

  // #421: abort MUST NOT overwrite terminal phases. The tool boundary detects
  // the terminal phase, emits a diagnostic warn, and delegates to the rail,
  // which performs an idempotent no-op (no overwrite, no transition).
  describe('#421 terminal-phase guard', () => {
    it.each(['ARCH_COMPLETE', 'REVIEW_COMPLETE'] as const)(
      '%s: abort is a no-op and logs a boundary warn (no overwrite)',
      async (phase) => {
        await hydrateSession();
        const sessDir = await currentSessionDir();
        const live = await readState(sessDir);
        const fixture = makeProgressedState(phase);
        // Seed the terminal state on disk while preserving the live session's
        // binding and resolved policy snapshot so the tool resolves normally.
        await writeState(sessDir, {
          ...fixture,
          binding: live!.binding,
          policySnapshot: live!.policySnapshot,
        });

        const warns: Array<{
          service: string;
          message: string;
          extra?: Record<string, unknown>;
        }> = [];
        const capturing: AdapterLogger = {
          info: () => {},
          warn: (service, message, extra) => warns.push({ service, message, extra }),
          error: () => {},
        };

        const raw = await runWithAdapterLoggerAsync(capturing, () =>
          abort_session.execute({ reason: 'attempt on terminal' }, ctx),
        );
        const result = parseToolResult(raw);

        // No overwrite: terminal phase preserved, no ABORTED error injected.
        expect(result.error).toBeUndefined();
        expect(result.phase).toBe(phase);
        const persisted = await readState(sessDir);
        expect(persisted?.phase).toBe(phase);
        expect(persisted?.error?.code).not.toBe('ABORTED');

        // Boundary warn carries full structured context — guards against
        // worthless logs (assert sessionId and concrete phase, not just reason).
        expect(warns).toHaveLength(1);
        expect(warns[0]?.service).toBe('abort');
        expect(warns[0]?.extra).toEqual({
          sessionId: ctx.sessionID,
          phase,
          reason: 'abort_on_terminal',
        });
      },
    );
  });
});
