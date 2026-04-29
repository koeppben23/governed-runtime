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
