/**
 * @module integration/audit-archive-integrity.test
 * @description Audit & Archive Integrity Integration Suite (T3).
 *
 * Focus: negative integrity behavior. Reader tolerance is allowed only as an
 * input primitive; regulated verification must surface corrupt or tampered
 * audit/archive state and fail closed by refusing a clean verified archive.
 *
 * @test-policy BAD, CORNER, EDGE
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  isTarAvailable,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import {
  hydrate,
  ticket,
  plan,
  decision,
  run_check,
  implement,
  review_implementation,
  status,
} from './tools/index.js';
import { readState } from '../adapters/persistence.js';
import { verifyChain } from '../audit/integrity.js';
import { computeChainHash, CURRENT_AUDIT_FORMAT_VERSION } from '../audit/types.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';
import type { ToolDefinition } from './tools/helpers.js';

vi.mock('../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'archive-initiator',
      email: 'archive@integrity.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

// Mock the verification executor to avoid real subprocess execution
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

vi.mock('../adapters/workspace/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/workspace/index.js')>();
  return {
    ...original,
    archiveSession: vi.fn(original.archiveSession),
    verifyArchive: vi.fn(original.verifyArchive),
  };
});

const actorMock = await import('../adapters/actor.js');
const workspaceMock = await import('../adapters/workspace/index.js');

const tarOk = await isTarAvailable();

let ws: TestWorkspace;
let ctx: TestToolContext;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
  vi.mocked(workspaceMock.archiveSession).mockImplementation(
    (
      await vi.importActual<typeof import('../adapters/workspace/index.js')>(
        '../adapters/workspace/index.js',
      )
    ).archiveSession,
  );
  vi.mocked(workspaceMock.verifyArchive).mockImplementation(
    (
      await vi.importActual<typeof import('../adapters/workspace/index.js')>(
        '../adapters/workspace/index.js',
      )
    ).verifyArchive,
  );
});

afterEach(async () => {
  clearUserDecisionIntents();
  vi.mocked(actorMock.resolveActor)
    .mockReset()
    .mockResolvedValue({
      id: 'archive-initiator',
      email: 'archive@integrity.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'claim_validated' as const,
    });
  vi.clearAllMocks();
  await ws.cleanup();
});

async function callOk(tool: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  const { sessDir } = await workspaceIds();
  const finalArgs = await withStrictReviewFindings(sessDir, args);
  recordDecisionIntentForTool(tool, finalArgs);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} - ${result.message}`);
  }
  return result;
}

function recordDecisionIntentForTool(tool: ToolDefinition, args: unknown): void {
  if (tool !== decision || typeof args !== 'object' || args === null) return;
  const verdict = (args as { verdict?: unknown }).verdict;
  if (verdict !== 'approve' && verdict !== 'changes_requested' && verdict !== 'reject') return;
  recordUserDecisionIntent({
    sessionId: ctx.sessionID,
    command: '/review-decision',
    expectedVerdict: verdict,
  });
}

async function phase(): Promise<string> {
  return parseToolResult(await status.execute({}, ctx)).phase as string;
}

async function workspaceIds(): Promise<{ fingerprint: string; sessDir: string }> {
  const fp = await computeFingerprint(ctx.worktree);
  return { fingerprint: fp.fingerprint, sessDir: resolveSessionDir(fp.fingerprint, ctx.sessionID) };
}

async function mutateArchive(
  ids: { fingerprint: string },
  mutate: (root: string) => Promise<void>,
): Promise<void> {
  const archivePath = path.join(
    process.env.OPENCODE_CONFIG_DIR ?? '',
    'workspaces',
    ids.fingerprint,
    'sessions',
    'archive',
    `${ctx.sessionID}.tar.gz`,
  );
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-tamper-'));
  try {
    await promisify(execFile)('tar', ['xzf', archivePath, '-C', stagingRoot]);
    await mutate(path.join(stagingRoot, ctx.sessionID));
    await promisify(execFile)('tar', ['czf', archivePath, '-C', stagingRoot, ctx.sessionID]);
    const digest = crypto
      .createHash('sha256')
      .update(await fs.readFile(archivePath))
      .digest('hex');
    await fs.writeFile(
      `${archivePath}.sha256`,
      `${digest}  ${path.basename(archivePath)}\n`,
      'utf-8',
    );
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

async function completeRegulatedSession(): Promise<{ fingerprint: string; sessDir: string }> {
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: 'archive-initiator',
    email: 'archive@integrity.dev',
    displayName: null,
    source: 'env' as const,
    assurance: 'claim_validated' as const,
  });
  await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
  await callOk(ticket, { text: 'Archive integrity task', source: 'user' });
  await callOk(plan, { planText: '## Plan\nBuild and verify.', targetPaths: ['docs/test.md'] });
  for (let i = 0; i < 4 && (await phase()) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { reviewVerdict: 'accept' });
  }
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: 'archive-reviewer',
    email: 'reviewer@integrity.dev',
    displayName: null,
    source: 'claim' as const,
    assurance: 'claim_validated' as const,
  });
  await callOk(decision, { verdict: 'approve', rationale: 'Plan approved' });
  // Run all active verification checks for the current phase (VALIDATION baseline or
  // IMPL_VALIDATION post-implementation). Discovery detects TypeScript → activeChecks=['typecheck'].
  const runActiveChecks = async (): Promise<void> => {
    const ids = await workspaceIds();
    const st = await readState(ids.sessDir);
    if (st && st.activeChecks.length > 0) {
      for (const kind of st.activeChecks) {
        await callOk(run_check, { kind });
      }
    }
  };
  await runActiveChecks();
  await callOk(implement, {});
  await runActiveChecks(); // IMPL_VALIDATION → IMPL_REVIEW
  for (let i = 0; i < 8 && (await phase()) !== 'EVIDENCE_REVIEW'; i++) {
    await callOk(review_implementation, { reviewVerdict: 'accept' });
  }
  await callOk(decision, { verdict: 'approve', rationale: 'Evidence approved' });
  expect(await phase()).toBe('COMPLETE');
  return workspaceIds();
}

function chainedEvent(prevHash: string, event: string): Record<string, unknown> {
  const base = {
    id: crypto.randomUUID(),
    sessionId: 'ses_chain_test',
    phase: 'READY',
    event,
    timestamp: new Date().toISOString(),
    actor: 'test',
    auditFormatVersion: CURRENT_AUDIT_FORMAT_VERSION,
    detail: { event },
    prevHash,
  };
  return { ...base, chainHash: computeChainHash(prevHash, base) };
}

describe('audit and archive integrity fail-closed behavior', () => {
  it('detects tampered chain hashes', () => {
    const first = chainedEvent('genesis', 'first');
    const second = chainedEvent(first.chainHash as string, 'second');
    const tampered = { ...second, chainHash: '0'.repeat(64) };

    const result = verifyChain([first, tampered]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('CHAIN_BREAK');
  });

  it('classifies chained pre-v2 audit events as legacy format, not chain tamper', () => {
    const first = chainedEvent('genesis', 'first');
    const { auditFormatVersion: _auditFormatVersion, ...legacy } = first;

    const result = verifyChain([legacy], { strict: true });
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('LEGACY_AUDIT_CHAIN_NOT_VERIFIABLE_WITH_V2');
  });

  it.skipIf(!tarOk)('regulated archive verification flags malformed audit lines', async () => {
    const ids = await completeRegulatedSession();
    await mutateArchive(ids, async (root) => {
      await fs.appendFile(path.join(root, 'audit', 'audit.jsonl'), '{not-json}\n', 'utf-8');
    });

    const verification = await workspaceMock.verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(
      verification.findings.some(
        (f) =>
          f.code === 'audit_chain_invalid' ||
          f.code === 'file_digest_mismatch' ||
          f.code === 'manifest_parse_error',
      ),
    ).toBe(true);
  });

  it.skipIf(!tarOk)(
    'archive verification detects manifest/file digest mismatch after evidence tamper',
    async () => {
      const ids = await completeRegulatedSession();
      await mutateArchive(ids, async (root) => {
        await fs.appendFile(
          path.join(root, 'archive-manifest.json'),
          '\n{"tampered":true}\n',
          'utf-8',
        );
      });

      const verification = await workspaceMock.verifyArchive(ids.fingerprint, ctx.sessionID);
      expect(verification.passed).toBe(false);
      expect(
        verification.findings.some(
          (f) => f.code === 'file_digest_mismatch' || f.code === 'manifest_parse_error',
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!tarOk)(
    'regulated completion records failed archive status when archive write fails',
    async () => {
      vi.mocked(workspaceMock.archiveSession).mockRejectedValueOnce(
        new Error('injected archive failure'),
      );

      await completeRegulatedSession();
      const state = await readState((await workspaceIds()).sessDir);
      expect(state?.phase).toBe('COMPLETE');
      expect(state?.archiveStatus).toBe('failed');
    },
  );

  it.skipIf(!tarOk)(
    'regulated archive verification rejects legacy unchained audit events',
    async () => {
      const ids = await completeRegulatedSession();
      const legacyEvent = {
        id: crypto.randomUUID(),
        sessionId: ctx.sessionID,
        phase: 'COMPLETE',
        event: 'legacy_after_archive',
        timestamp: new Date().toISOString(),
        actor: 'legacy',
        detail: { source: 'test' },
      };
      await mutateArchive(ids, async (root) => {
        await fs.appendFile(
          path.join(root, 'audit', 'audit.jsonl'),
          `${JSON.stringify(legacyEvent)}\n`,
          'utf-8',
        );
      });

      const verification = await workspaceMock.verifyArchive(ids.fingerprint, ctx.sessionID);
      expect(verification.passed).toBe(false);
      expect(
        verification.findings.some(
          (f) =>
            f.code === 'audit_chain_invalid' ||
            f.code === 'file_digest_mismatch' ||
            f.code === 'manifest_parse_error',
        ),
      ).toBe(true);
    },
  );
});
