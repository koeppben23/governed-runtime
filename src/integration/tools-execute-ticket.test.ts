/**
 * @module integration/tools-execute-ticket.test
 * @description Execution tests for the ticket FlowGuard tool execute() functions.
 *
 * Tests the ticket tool against real filesystem persistence with
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
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createToolContext,
  createTestWorkspace,
  isTarAvailable,
  parseToolResult,
  isBlockedResult,
  assertTestConfigDir,
  fulfillStrictReviewObligation,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from './test-helpers.js';
import {
  status,
  hydrate,
  ticket,
  plan,
  architecture,
  decision,
  implement,
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
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';
import type { ReviewVerdict } from '../state/evidence.js';

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
  clearUserDecisionIntents();
  vi.clearAllMocks();
  await ws.cleanup();
});

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
        await import('../adapters/workspace/index.js');
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
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket!.text).toBe('Second ticket');
    });

    it('re-ticketing from non-TICKET phase is blocked', async () => {
      await hydrateAndTicket('First ticket');
      // Submit plan → phase advances from TICKET
      await plan.execute({ planText: '## Plan\n1. Do stuff', targetPaths: ['docs/test.md'] }, ctx);
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

    it('stores references with Jira URL and extractedAt', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        {
          text: 'Fix login redirect after token expiry',
          source: 'external',
          inputOrigin: 'external_reference',
          references: [
            {
              ref: 'https://jira.example.com/browse/PROJ-123',
              type: 'ticket',
              title: 'PROJ-123: Fix login redirect',
              source: 'jira',
              extractedAt: '2026-01-15T10:00:00.000Z',
            },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket!.references).toHaveLength(1);
      expect(state!.ticket!.references![0]!.ref).toBe('https://jira.example.com/browse/PROJ-123');
      expect(state!.ticket!.references![0]!.type).toBe('ticket');
      expect(state!.ticket!.references![0]!.source).toBe('jira');
      expect(state!.ticket!.references![0]!.extractedAt).toBe('2026-01-15T10:00:00.000Z');
      expect(state!.ticket!.inputOrigin).toBe('external_reference');
    });

    it('stores multiple references across platforms', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        {
          text: 'Implement feature X with spec alignment',
          source: 'external',
          inputOrigin: 'mixed',
          references: [
            { ref: 'https://jira.example.com/PROJ-42', type: 'ticket', source: 'jira' },
            { ref: 'https://confluence.example.com/SPEC-1', type: 'doc', source: 'confluence' },
            { ref: 'https://github.com/org/repo/issues/7', type: 'issue', source: 'github' },
          ],
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
    });

    it('sets inputOrigin=manual_text for user-typed tickets', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        { text: 'Fix the auth bug in login.ts', source: 'user', inputOrigin: 'manual_text' },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket!.inputOrigin).toBe('manual_text');
      expect(state!.ticket!.references).toBeUndefined();
    });

    it('normalizes empty references array (not persisted)', async () => {
      await hydrateSession();
      const raw = await ticket.execute(
        { text: 'Just a task', source: 'user', references: [] },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      expect(state!.ticket!.references).toBeUndefined();
    });
  });
});
