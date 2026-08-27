/**
 * @module integration/Execution tests for the implement tool
 * @description Execution tests for the implement tool.
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
  review_implementation,
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
    headCommitFull: vi.fn().mockResolvedValue('d'.repeat(40)),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
    // Deterministic per-path content hash so baseline scoping is testable: a
    // file is "unchanged since baseline" iff the baseline recorded this same
    // `stable:<path>` value; tests that simulate a real edit record a DIFFERENT
    // baseline hash for that path.
    hashWorktreeFiles: vi.fn(async (_worktree: string, paths: readonly string[]) => {
      const out: Record<string, string | null> = {};
      for (const p of paths) out[p] = `stable:${p}`;
      return out;
    }),
    // Defaults to the real helper (which returns '' on the non-repo temp worktree);
    // F3 tests override it per-call to exercise diff-artifact capture.
    worktreeDiff: vi.fn(original.worktreeDiff),
  };
});

vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/frozen-repository.js')>();
  return {
    ...original,
    freezeRepositoryIdentity: vi.fn(() => ({
      kind: 'local' as const,
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    })),
    freezeWorktreeCandidate: vi.fn().mockResolvedValue('c'.repeat(40)),
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

// Transparent pass-through to the real implement-diff-artifact module so
// writeImplementationDiffArtifact can be selectively intercepted per-test
// (e.g. the F3 write-failure negative case).
vi.mock('./tools/implement-diff-artifact.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./tools/implement-diff-artifact.js')>();
  return {
    writeImplementationDiffArtifact: vi.fn(actual.writeImplementationDiffArtifact),
  };
});

// Lazy import for per-test overrides
const gitMock = await import('../adapters/git.js');
const wsMock = await import('../adapters/workspace/index.js');
const actorMock = await import('../adapters/actor.js');
const persistenceMock = await import('../adapters/persistence.js');
const executorMock = await import('../verification/executor.js');
const diffArtifactMock = await import('./tools/implement-diff-artifact.js');

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
  // Pre-implementation baseline (#baseline): hydrate snapshots the dirty
  // worktree once. Simulate a clean start so later changedFiles mocks represent
  // the task's own edits (not pre-existing dirt).
  const gitMockForBaseline = await import('../adapters/git.js');
  vi.mocked(gitMockForBaseline.changedFiles).mockResolvedValueOnce([]);
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

async function fulfillReview(
  obligationType: 'plan' | 'implement',
  iteration: number,
  overallVerdict: 'accept' | 'changes_requested' = 'accept',
) {
  return fulfillStrictReviewObligation(await currentSessionDir(), {
    obligationType,
    iteration,
    planVersion: 1,
    overallVerdict,
  });
}

function implementationReview(result: Record<string, unknown>): {
  reviewMode: string;
  iteration: number;
} {
  const review = result.latestImplementationReview;
  if (
    review === null ||
    typeof review !== 'object' ||
    typeof (review as Record<string, unknown>).reviewMode !== 'string' ||
    typeof (review as Record<string, unknown>).iteration !== 'number'
  ) {
    throw new TypeError('Expected latestImplementationReview summary');
  }
  return review as { reviewMode: string; iteration: number };
}

// ═══════════════════════════════════════════════════════════════════════════
// Tool: implement
// ═══════════════════════════════════════════════════════════════════════════

describe('implement', () => {
  /** Helper: reach IMPLEMENTATION phase via solo workflow. */
  async function reachImplementation(): Promise<void> {
    await hydrateAndTicket();
    await plan.execute({ planText: '## Plan\n1. Fix auth', targetPaths: ['docs/test.md'] }, ctx);
    const planReviewFindings = await fulfillReview('plan', 0, 'accept');
    await plan.execute({ reviewVerdict: 'accept', reviewFindings: planReviewFindings }, ctx);
    // Solo: PLAN_REVIEW auto-approves → VALIDATION
    // Discovery detects TypeScript → activeChecks=['typecheck'] → run check to advance
    const sessDir = await currentSessionDir();
    const state = await readState(sessDir);
    if (state && state.activeChecks.length > 0) {
      for (const kind of state.activeChecks) {
        await run_check.execute({ kind }, ctx);
      }
    }
  }

  /**
   * Re-run the active checks in IMPL_VALIDATION (the post-implementation re-run
   * against the fixed code) to advance IMPL_VALIDATION → IMPL_REVIEW. No-op unless
   * the session is currently in IMPL_VALIDATION with active checks.
   */
  async function passImplValidation(): Promise<Record<string, unknown> | null> {
    const sessDir = await currentSessionDir();
    const state = await readState(sessDir);
    if (!state || state.phase !== 'IMPL_VALIDATION' || state.activeChecks.length === 0) return null;
    let result: Record<string, unknown> | null = null;
    for (const kind of state.activeChecks) {
      result = parseToolResult(await run_check.execute({ kind }, ctx));
    }
    return result;
  }

  describe('HAPPY', () => {
    it('defers implementation review obligation and invocation until post-implementation checks pass', async () => {
      await reachImplementation();
      const recordResult = parseToolResult(await implement.execute({}, ctx));
      const sessDir = await currentSessionDir();

      expect(recordResult.phase).toBe('IMPL_VALIDATION');
      expect(recordResult.next).toContain('/check');
      expect(recordResult.next).not.toContain('INDEPENDENT_REVIEW_REQUIRED');
      expect(recordResult.reviewObligation).toBeUndefined();
      expect(recordResult.reviewInvocation).toBeUndefined();
      expect(
        (await readState(sessDir))?.reviewAssurance?.obligations.filter(
          (obligation) => obligation.obligationType === 'implement',
        ) ?? [],
      ).toHaveLength(0);

      const validationResult = await passImplValidation();
      expect(validationResult?.phase).toBe('IMPL_REVIEW');
      expect(validationResult?.reviewObligation).toBeDefined();
      expect(validationResult?.reviewInvocation).toBeDefined();
      expect(String(validationResult?.next)).toContain('INDEPENDENT_REVIEW_REQUIRED');
      expect(
        (await readState(sessDir))?.reviewAssurance?.obligations.filter(
          (obligation) => obligation.obligationType === 'implement',
        ) ?? [],
      ).toHaveLength(1);
    });

    it('Mode A: records changed files from git', async () => {
      await reachImplementation();
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.changedFiles).toBeDefined();
      expect(result.domainFiles).toBeDefined();
    });

    it('F3: binds a content digest and writes the change diff artifact', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const diff =
        'diff --git a/src/auth.ts b/src/auth.ts\n' +
        '--- a/src/auth.ts\n+++ b/src/auth.ts\n@@ -1 +1 @@\n-old\n+new\n';
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['src/auth.ts']);
      vi.mocked(gitMock.worktreeDiff).mockResolvedValueOnce(diff);

      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      expect(parseToolResult(raw).error).toBeUndefined();

      const state = await readState(sessDir);
      const impl = state!.implementation!;
      // Digest is derived from per-path CONTENT hashes (see hashWorktreeFiles mock),
      // not a hash of the file-name list — distinct content yields a distinct digest.
      expect(impl.digest).toBeTruthy();
      expect(impl.diffDigest).toBeTruthy();

      // The diff artifact is written, content-addressed by diffDigest, and is picked
      // up by the archive manifest (it lives under the session directory).
      const patch = await fs.readFile(
        `${sessDir}/implementation-diff.${impl.diffDigest}.patch`,
        'utf8',
      );
      expect(patch).toBe(diff);
    });

    it('F3: omits diffDigest and writes no artifact when the diff is empty', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['src/auth.ts']);
      vi.mocked(gitMock.worktreeDiff).mockResolvedValueOnce('   \n');

      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      expect(parseToolResult(raw).error).toBeUndefined();

      const impl = (await readState(sessDir))!.implementation!;
      expect(impl.diffDigest).toBeUndefined();
    });

    it('F3: omits diffDigest and never persists a claimed artifact when write fails', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['src/auth.ts']);
      vi.mocked(gitMock.worktreeDiff).mockResolvedValueOnce(
        'diff --git a/src/auth.ts b/src/auth.ts\n--- a/src/auth.ts\n+++ b/src/auth.ts',
      );
      // Simulate writeImplementationDiffArtifact failing (ENOSPC).
      vi.mocked(diffArtifactMock.writeImplementationDiffArtifact).mockResolvedValueOnce(false);

      const raw = await implement.execute({}, ctx);
      expect(parseToolResult(raw).error).toBeUndefined();

      const impl = (await readState(sessDir))!.implementation!;
      // Implementation recording itself must still succeed (best-effort diff).
      expect(impl.digest).toBeTruthy();
      // diffDigest must NOT be set — no artifact was written.
      expect(impl.diffDigest).toBeUndefined();
    });

    it('Mode B: approve review converges in solo', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();
      const reviewFindings = await fulfillReview('implement', 1, 'accept');
      const raw = await review_implementation.execute(
        { reviewVerdict: 'accept', reviewFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(
        result.converged === true ||
          result.phase === 'EVIDENCE_REVIEW' ||
          result.phase === 'COMPLETE',
      ).toBe(true);
    });

    it('reduced ceremony records evidence and skips implementation review obligation only for runtime-verified TRIVIAL changes', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        claimedTaskClass: 'TRIVIAL',
        policySnapshot: { ...state!.policySnapshot, allowReducedCeremony: true },
      });

      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['docs/usage-notes.md']);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      const finalState = await readState(sessDir);

      expect(result.error).toBeUndefined();
      expect(result.ceremonyProfile).toBe('reduced');
      expect(result.computedMinimumTaskClass).toBe('TRIVIAL');
      expect(result.reviewMode).toBe('reduced_ceremony');
      expect(finalState?.implementation).not.toBeNull();
      expect(finalState?.implReview).toBeNull();
      expect(finalState?.reducedCeremony).toMatchObject({
        profile: 'reduced',
        reason: 'RUNTIME_VERIFIED_TRIVIAL',
        claimedTaskClass: 'TRIVIAL',
        computedMinimumTaskClass: 'TRIVIAL',
      });
      expect(finalState?.transition?.event).toBe('APPROVE');
      expect(finalState?.phase).toBe('COMPLETE');
      expect(
        finalState?.reviewAssurance?.obligations.some(
          (obligation) => obligation.obligationType === 'implement',
        ) ?? false,
      ).toBe(false);
    });

    it('keeps full implementation review for computed HIGH-RISK surfaces even when reduced ceremony is enabled', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        claimedTaskClass: 'TRIVIAL',
        policySnapshot: { ...state!.policySnapshot, allowReducedCeremony: true },
      });

      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['src/security/policy.ts']);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      const finalState = await readState(sessDir);

      expect(result.error).toBeUndefined();
      expect(result.ceremonyProfile).toBe('full');
      expect(result.ceremonyReason).toBe('COMPUTED_MINIMUM_NOT_TRIVIAL');
      expect(result.computedMinimumTaskClass).toBe('HIGH-RISK');
      expect(finalState?.reducedCeremony).toBeNull();
      expect(finalState?.phase).toBe('IMPL_REVIEW');
      expect(
        finalState?.reviewAssurance?.obligations.some(
          (obligation) => obligation.obligationType === 'implement',
        ) ?? false,
      ).toBe(true);
    });
  });

  describe('BAD', () => {
    it('blocks recording while a dispatched host mutation has no completion outcome', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      if (!state) throw new Error('expected session state');
      await writeState(sessDir, {
        ...state,
        mutationEpisodes: [
          {
            episodeId: crypto.randomUUID(),
            hostCallId: 'host-call-1',
            toolName: 'edit',
            authorizedAt: new Date().toISOString(),
            status: 'dispatch_authorized',
            completedAt: null,
            outcome: null,
            implementationDigest: null,
            evidenceStatus: 'ineligible',
          },
        ],
      });

      const result = parseToolResult(await implement.execute({}, ctx));
      expect(result).toMatchObject({
        error: true,
        code: 'MUTATION_EPISODE_UNRESOLVED',
      });
    });
  });

  describe('BAD', () => {
    it('blocks without session', async () => {
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('NO_SESSION');
    });

    it('blocks without plan/ticket', async () => {
      await hydrateSession();
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
    });
  });

  describe('CORNER', () => {
    it('filters out .opencode/ files from domain files', async () => {
      await reachImplementation();
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'src/foo.ts',
        '.opencode/tools/flowguard.ts',
        'node_modules/dep/index.js',
      ]);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      const domain = result.domainFiles as string[];
      expect(domain).toContain('src/foo.ts');
      expect(domain).not.toContain('.opencode/tools/flowguard.ts');
      expect(domain).not.toContain('node_modules/dep/index.js');
    });

    it('excludes root tool config (opencode.json) from domain files but keeps it in changedFiles', async () => {
      // Real demo case: a stale opencode.json detected in the worktree must not
      // be counted as an implementation domain surface.
      await reachImplementation();
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'opencode.json',
        'src/main/Service.java',
        'tsconfig.json',
      ]);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      const domain = result.domainFiles as string[];
      const changed = result.changedFiles as string[];
      expect(domain).toContain('src/main/Service.java');
      expect(domain).not.toContain('opencode.json');
      expect(domain).not.toContain('tsconfig.json');
      // changedFiles still reports the full git-detected set for transparency.
      expect(changed).toContain('opencode.json');
    });

    it('baseline scoping subtracts pre-existing dirty files from the implementation evidence', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      // A stale file was already dirty at session start and is UNCHANGED since
      // (its recorded baseline hash matches the deterministic re-hash mock).
      await writeState(sessDir, {
        ...state!,
        implementationBaseline: {
          dirtyFiles: [{ path: 'stale/preexisting.txt', hash: 'stable:stale/preexisting.txt' }],
          capturedAt: new Date().toISOString(),
        },
      });
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'src/main/Service.java',
        'stale/preexisting.txt',
      ]);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.baselineScoping).toBe('applied');
      const changed = result.changedFiles as string[];
      expect(changed).toContain('src/main/Service.java');
      expect(changed).not.toContain('stale/preexisting.txt');
    });

    it('keeps a pre-dirty file the task actually modified (content hash changed)', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      // The file was dirty at start with a DIFFERENT hash; the task then edited
      // it, so the current re-hash differs and it must NOT be scoped out.
      await writeState(sessDir, {
        ...state!,
        implementationBaseline: {
          dirtyFiles: [{ path: 'src/main/Service.java', hash: 'old:src/main/Service.java' }],
          capturedAt: new Date().toISOString(),
        },
      });
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['src/main/Service.java']);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.baselineScoping).toBe('applied');
      const changed = result.changedFiles as string[];
      expect(changed).toContain('src/main/Service.java');
    });

    it('absent baseline records the full worktree and marks scoping unavailable', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      // Simulate a legacy session: strip any captured baseline.
      if (!state) throw new TypeError('Expected persisted session state');
      const { implementationBaseline: _drop, ...withoutBaseline } = state;
      await writeState(sessDir, withoutBaseline);
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'src/main/Service.java',
        'stale/preexisting.txt',
      ]);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.baselineScoping).toBe('unavailable');
      const changed = result.changedFiles as string[];
      // No subtraction: the full worktree is recorded, nothing hidden.
      expect(changed).toContain('src/main/Service.java');
      expect(changed).toContain('stale/preexisting.txt');
    });

    it('a stale HIGH-RISK file in the baseline does not escalate ceremony once scoped out', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        claimedTaskClass: 'TRIVIAL',
        policySnapshot: { ...state!.policySnapshot, allowReducedCeremony: true },
        implementationBaseline: {
          dirtyFiles: [{ path: 'package.json', hash: 'stable:package.json' }],
          capturedAt: new Date().toISOString(),
        },
      });
      // The task only touched a doc; a stale dirty package.json (HIGH-RISK) was
      // present before the task, unchanged, and must be scoped out, not raise
      // the floor.
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce([
        'docs/usage-notes.md',
        'package.json',
      ]);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.baselineScoping).toBe('applied');
      expect(result.computedMinimumTaskClass).toBe('TRIVIAL');
      expect(result.ceremonyProfile).toBe('reduced');
    });

    it('blocks when every changed file was already dirty and unchanged since session start', async () => {
      await reachImplementation();
      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        implementationBaseline: {
          dirtyFiles: [
            { path: 'stale/a.txt', hash: 'stable:stale/a.txt' },
            { path: 'stale/b.txt', hash: 'stable:stale/b.txt' },
          ],
          capturedAt: new Date().toISOString(),
        },
      });
      vi.mocked(gitMock.changedFiles).mockResolvedValueOnce(['stale/a.txt', 'stale/b.txt']);
      const raw = await implement.execute({}, ctx);
      await passImplValidation();
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_EMPTY');
    });

    it('Mode B blocks with IMPLEMENTATION_EVIDENCE_REQUIRED before evidence is recorded', async () => {
      await reachImplementation();
      const raw = await review_implementation.execute({ reviewVerdict: 'accept' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_REQUIRED');
      // #499 anti-confabulation: the block echoes the verdict the caller actually
      // sent (the real field-evidence case from the #499 implement-surface report,
      // where the agent narrated an "empty" call while submitting a verdict).
      expect(result.message).toContain('accept');
    });

    it('blocks reviewerUnavailable before implementation evidence is recorded', async () => {
      await reachImplementation();
      const raw = await review_implementation.execute({ reviewerUnavailable: true }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_REQUIRED');
    });

    it('reports a preferred host Task transport failure without consuming the implementation obligation', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const sessDir = await currentSessionDir();
      const state = await readState(sessDir);
      const retryState = {
        ...state!,
        policySnapshot: {
          ...state!.policySnapshot!,
          reviewInvocationPolicy: 'host_task_preferred' as const,
        },
      };
      await writeState(sessDir, retryState);

      const raw = await review_implementation.execute({ reviewerUnavailable: true }, ctx);
      const result = parseToolResult(raw);
      const after = await readState(sessDir);
      expect(result.error).toBeUndefined();
      expect(result.phase).toBe('IMPL_REVIEW');
      expect(result.reviewTransportFailure).toEqual({ transport: 'host_task', reported: true });
      expect(result.reviewObligationId).toBeTruthy();
      expect(after?.reviewAssurance).toEqual(retryState.reviewAssurance);
      expect(after?.implReview).toEqual(retryState.implReview);
    });

    it('Mode B blocks with IMPLEMENTATION_EVIDENCE_REQUIRED when implementation is null', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        implementation: null,
      });

      const raw = await review_implementation.execute({ reviewVerdict: 'accept' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('IMPLEMENTATION_EVIDENCE_REQUIRED');
    });
  });

  describe('P34b: Agent-Orchestrated Implementation Review', () => {
    const validReviewFindingsSubagent = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'accept' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_test' },
      reviewedAt: new Date().toISOString(),
    };

    const validReviewFindingsSelf = {
      iteration: 0,
      planVersion: 1,
      reviewMode: 'self' as unknown as 'subagent',
      overallVerdict: 'accept' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: { sessionId: 'ses_self' },
      reviewedAt: new Date().toISOString(),
    };

    async function setSelfReviewPolicy(
      subagentEnabled: boolean,
      fallbackToSelf: boolean,
    ): Promise<void> {
      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);
      await writeState(sessDir, {
        ...state!,
        policySnapshot: {
          ...state!.policySnapshot,
          selfReview: { subagentEnabled, fallbackToSelf, strictEnforcement: false },
        },
      });
    }

    async function enterImplReview(): Promise<void> {
      await implement.execute({}, ctx);
      await passImplValidation();
    }

    it('reviewMode=subagent accepted by mandatory default in Mode B', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'accept');
      const raw = await review_implementation.execute(
        { reviewVerdict: 'accept', reviewFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(implementationReview(result).reviewMode).toBe('subagent');
    });

    it('reviewMode=self blocked by mandatory default in Mode B', async () => {
      await reachImplementation();
      await enterImplReview();
      const raw = await review_implementation.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: { ...validReviewFindingsSelf, iteration: 1 },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('planVersion mismatch blocked in Mode B', async () => {
      await reachImplementation();
      await enterImplReview();
      const wrongVersion = { ...validReviewFindingsSubagent, iteration: 1, planVersion: 99 };
      const raw = await review_implementation.execute(
        {
          reviewVerdict: 'changes_requested',
          reviewFindings: wrongVersion,
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('reviewFindings without reviewVerdict blocks with INVALID_IMPLEMENT_TOOL_SEQUENCE', async () => {
      await reachImplementation();
      const raw = await review_implementation.execute(
        { reviewFindings: validReviewFindingsSubagent },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('INVALID_IMPLEMENT_TOOL_SEQUENCE');
    });

    it('subagentEnabled=true + reviewMode=subagent -> accepted in Mode B', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'accept');
      const raw = await review_implementation.execute(
        { reviewVerdict: 'accept', reviewFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.latestImplementationReview).toBeTruthy();
      expect(implementationReview(result).reviewMode).toBe('subagent');
    });

    it('subagentEnabled=true + fallbackToSelf=true + reviewMode=self -> BLOCKED in Mode B', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, true);
      await enterImplReview();
      const raw = await review_implementation.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: { ...validReviewFindingsSelf, iteration: 1 },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('subagentEnabled=true + fallbackToSelf=false + reviewMode=self -> BLOCKED in Mode B', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await enterImplReview();
      const raw = await review_implementation.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: { ...validReviewFindingsSelf, iteration: 1 },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('Mode B: missing mandatory reviewer findings blocks approve', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();
      const raw = await review_implementation.execute({ reviewVerdict: 'accept' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('Mode B: reviewMode=self blocked when subagentEnabled=true and fallbackToSelf=false', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await enterImplReview();

      const modeBFindings = { ...validReviewFindingsSelf, iteration: 1 };
      const raw = await review_implementation.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: modeBFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_MODE_SELF_NOT_ALLOWED');
    });

    it('Mode B: planVersion mismatch blocked', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const wrongVersion = { ...validReviewFindingsSubagent, iteration: 1, planVersion: 99 };
      const raw = await review_implementation.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: wrongVersion },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_PLAN_VERSION_MISMATCH');
    });

    it('Mode B: iteration mismatch blocked', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const wrongIteration = { ...validReviewFindingsSubagent, iteration: 99 };
      const raw = await review_implementation.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: wrongIteration },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_ITERATION_MISMATCH');
    });

    it('Mode B: reviewVerdict must match reviewFindings overallVerdict', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const changesRequestedFindings = await fulfillReview('implement', 1, 'changes_requested');
      const raw = await review_implementation.execute(
        { reviewVerdict: 'accept', reviewFindings: changesRequestedFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('SUBAGENT_FINDINGS_VERDICT_MISMATCH');
    });

    it('Mode B: changes_requested accepted with valid reviewFindings', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const validModeBFindings = await fulfillReview('implement', 1, 'changes_requested');
      const raw = await review_implementation.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: validModeBFindings },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBeUndefined();
      expect(result.status).toContain('Changes requested');
    });

    it('Mode B: changes_requested returns to IMPLEMENTATION for fresh implementation evidence', async () => {
      await reachImplementation();
      await implement.execute({}, ctx);
      await passImplValidation();

      const validModeBFindings = await fulfillReview('implement', 1, 'changes_requested');
      const reviewRaw = await review_implementation.execute(
        { reviewVerdict: 'changes_requested', reviewFindings: validModeBFindings },
        ctx,
      );
      const reviewResult = parseToolResult(reviewRaw);
      expect(reviewResult.error).toBeUndefined();
      expect(reviewResult.phase).toBe('IMPLEMENTATION');

      const sessDir = await currentSessionDir();
      const afterReviewState = await readState(sessDir);
      expect(afterReviewState?.implementation).toBeNull();
      expect(afterReviewState?.implReview).toBeNull();
      expect(afterReviewState?.reducedCeremony).toBeNull();

      const recordRaw = await implement.execute({}, ctx);
      const validationResult = await passImplValidation();
      const recordResult = parseToolResult(recordRaw);
      expect(recordResult.error).toBeUndefined();
      expect(recordResult.phase).toBe('IMPL_VALIDATION');
      expect(recordResult.reviewObligationIteration).toBeUndefined();
      expect(validationResult?.reviewObligationIteration).toBe(2);

      const afterRecordState = await readState(sessDir);
      expect(afterRecordState?.implementation).not.toBeNull();
      expect(afterRecordState?.implReview).toBeNull();
      expect(afterRecordState?.implReviewFindings).toHaveLength(1);

      const secondReviewFindings = await fulfillReview('implement', 2, 'accept');
      const approveRaw = await review_implementation.execute(
        { reviewVerdict: 'accept', reviewFindings: secondReviewFindings },
        ctx,
      );
      const approveResult = parseToolResult(approveRaw);
      expect(approveResult.error).toBeUndefined();
      expect(approveResult.implReviewIteration).toBe(2);
      expect(['EVIDENCE_REVIEW', 'COMPLETE']).toContain(approveResult.phase);
    });

    it('approve + subagentEnabled=true + missing reviewFindings -> BLOCKED', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);
      await implement.execute({}, ctx);
      await passImplValidation();

      const raw = await review_implementation.execute({ reviewVerdict: 'accept' }, ctx);
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_REQUIRED');
    });

    it('Mode B: changes_requested with NO resolvable findings still returns to IMPLEMENTATION (no dead-state)', async () => {
      // Regression: a reviewer asking for changes must never wedge the session
      // into an unrecoverable IMPL_REVIEW state. Unlike `accept`, changes_requested
      // closes the loop by returning to IMPLEMENTATION (fresh evidence replaces the
      // stale evidence), so it must NOT require bindable reviewer findings. The
      // sibling `accept` case above stays BLOCKED with REVIEW_FINDINGS_REQUIRED.
      await reachImplementation();
      await enterImplReview(); // pending obligation, but NO bound reviewer evidence

      const reviewRaw = await review_implementation.execute(
        { reviewVerdict: 'changes_requested' },
        ctx,
      );
      const reviewResult = parseToolResult(reviewRaw);
      expect(reviewResult.error).toBeUndefined();
      expect(reviewResult.phase).toBe('IMPLEMENTATION');

      const sessDir = await currentSessionDir();
      const afterReviewState = await readState(sessDir);
      expect(afterReviewState?.implementation).toBeNull();
      expect(afterReviewState?.implReview).toBeNull();

      // Recovery is actually reachable: re-recording implementation works.
      const recordRaw = await implement.execute({}, ctx);
      const validationResult = await passImplValidation();
      const recordResult = parseToolResult(recordRaw);
      expect(recordResult.error).toBeUndefined();
      expect(recordResult.phase).toBe('IMPL_VALIDATION');
      // No reviewer findings were recorded for the changes_requested cycle, so the
      // next review obligation starts fresh at iteration 1 (not 2).
      expect(recordResult.reviewObligationIteration).toBeUndefined();
      expect(validationResult?.reviewObligationIteration).toBe(1);
    });

    it('approve + subagentEnabled=true + valid reviewFindings -> accepted', async () => {
      await reachImplementation();
      await setSelfReviewPolicy(true, false);

      await enterImplReview();
      const modeBFindings = await fulfillReview('implement', 1, 'accept');
      const raw = await review_implementation.execute(
        { reviewVerdict: 'accept', reviewFindings: modeBFindings },
        ctx,
      );
      const result = parseToolResult(raw);

      expect(result.error).toBeUndefined();
      expect(result.implReviewIteration).toBeGreaterThanOrEqual(1);
      expect(result.latestImplementationReview).toBeTruthy();
      expect(implementationReview(result).reviewMode).toBe('subagent');
    });

    it('blocks tampered implementation review findings that do not match evidence', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'accept');

      const raw = await review_implementation.execute(
        {
          reviewVerdict: 'accept',
          reviewFindings: {
            ...reviewFindings,
            missingVerification: ['tampered verification gap'],
          },
        },
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).toBe(true);
      expect(result.code).toBe('REVIEW_FINDINGS_HASH_MISMATCH');
    });

    it('persists implReviewFindings in state', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'accept');
      await review_implementation.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);

      const { computeFingerprint, sessionDir: resolveSessionDir } =
        await import('../adapters/workspace/index.js');
      const fp = await computeFingerprint(ws.tmpDir);
      const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
      const state = await readState(sessDir);

      expect(state).not.toBeNull();
      if (!state) throw new TypeError('Expected persisted session state');
      expect(state.implReviewFindings).toHaveLength(1);
      expect(state.implReviewFindings?.[0]?.reviewMode).toBe('subagent');
    });

    it('latestImplementationReview appears in status', async () => {
      await reachImplementation();
      await enterImplReview();
      const reviewFindings = await fulfillReview('implement', 1, 'accept');
      await review_implementation.execute({ reviewVerdict: 'accept', reviewFindings }, ctx);

      const raw = await status.execute({}, ctx);
      const result = parseToolResult(raw);

      expect(result.latestImplementationReview).toBeDefined();
      expect(implementationReview(result).reviewMode).toBe('subagent');
      expect(implementationReview(result).iteration).toBe(1);
    });

    // ─── P1.3 slice 8: third-verdict end-to-end through tool layer ──────
    describe('EDGE: unable_to_review tool-layer integration', () => {
      it('blocks implement with SUBAGENT_UNABLE_TO_REVIEW when findings.overallVerdict=unable_to_review (E2E)', async () => {
        // End-to-end mirror of the plan-layer slice-8 test: real impl
        // obligation, mutated finding verdict, full tool-layer pipeline.
        await reachImplementation();
        await enterImplReview();
        const baseFindings = await fulfillReview('implement', 1, 'accept');
        const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

        const raw = await review_implementation.execute(
          { reviewVerdict: 'changes_requested', reviewFindings: unableFindings },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBe(true);
        expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      });

      it('blocks implement even when paired with reviewVerdict=approve (E2E precedence)', async () => {
        // unable_to_review must override any submitted reviewVerdict.
        await reachImplementation();
        await enterImplReview();
        const baseFindings = await fulfillReview('implement', 1, 'accept');
        const unableFindings = { ...baseFindings, overallVerdict: 'unable_to_review' as const };

        const raw = await review_implementation.execute(
          { reviewVerdict: 'accept', reviewFindings: unableFindings },
          ctx,
        );
        const result = parseToolResult(raw);
        expect(result.error).toBe(true);
        expect(result.code).toBe('SUBAGENT_UNABLE_TO_REVIEW');
      });
    });
  });

  // ═══════════════════════════════════════════════════════════════════════════════
  // BUG-21: Null-tolerant record tool (defense-in-depth for Fix E)
  // The record tool (flowguard_implement) takes no arguments; any stray/null
  // verdict-shaped keys injected by a model are ignored and evidence is recorded
  // (issue #565: the record tool can no longer carry a verdict at all).
  // ═══════════════════════════════════════════════════════════════════════════════

  describe('BUG-21: null-tolerant record tool (implement tool)', () => {
    it('HAPPY: stray reviewVerdict=null is ignored → records implementation', async () => {
      await reachImplementation();
      const raw = await implement.execute({ reviewVerdict: null } as any, ctx);
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.changedFiles).toBeDefined();
    });

    it('HAPPY: stray reviewFindings=null is ignored → records implementation', async () => {
      await reachImplementation();
      const raw = await implement.execute({ reviewFindings: null } as any, ctx);
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.changedFiles).toBeDefined();
    });

    it('CORNER: both stray reviewVerdict=null + reviewFindings=null → records implementation', async () => {
      await reachImplementation();
      const raw = await implement.execute(
        { reviewVerdict: null, reviewFindings: null } as any,
        ctx,
      );
      const result = parseToolResult(raw);
      expect(result.error).not.toBe(true);
      expect(result.changedFiles).toBeDefined();
    });
  });
});
