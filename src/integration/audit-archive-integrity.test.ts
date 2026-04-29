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
import * as path from 'node:path';
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
import { hydrate, ticket, plan, decision, validate, implement, status } from './tools/index.js';
import { readAuditTrail, readState } from '../adapters/persistence.js';
import { verifyChain } from '../audit/integrity.js';
import { computeChainHash } from '../audit/types.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../adapters/workspace/index.js';

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

async function callOk(
  tool: { execute: (args: unknown, context: TestToolContext) => Promise<string> },
  args: unknown,
): Promise<Record<string, unknown>> {
  const { sessDir } = await workspaceIds();
  const finalArgs = await withStrictReviewFindings(sessDir, args);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} - ${result.message}`);
  }
  return result;
}

async function phase(): Promise<string> {
  return parseToolResult(await status.execute({}, ctx)).phase as string;
}

async function workspaceIds(): Promise<{ fingerprint: string; sessDir: string }> {
  const fp = await computeFingerprint(ctx.worktree);
  return { fingerprint: fp.fingerprint, sessDir: resolveSessionDir(fp.fingerprint, ctx.sessionID) };
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
  await callOk(plan, { planText: '## Plan\nBuild and verify.' });
  for (let i = 0; i < 4 && (await phase()) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { selfReviewVerdict: 'approve' });
  }
  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: 'archive-reviewer',
    email: 'reviewer@integrity.dev',
    displayName: null,
    source: 'claim' as const,
    assurance: 'claim_validated' as const,
  });
  await callOk(decision, { verdict: 'approve', rationale: 'Plan approved' });
  await callOk(validate, {
    results: [
      { checkId: 'test_quality', passed: true, detail: 'OK' },
      { checkId: 'rollback_safety', passed: true, detail: 'OK' },
    ],
  });
  await callOk(implement, {});
  for (let i = 0; i < 8 && (await phase()) !== 'EVIDENCE_REVIEW'; i++) {
    await callOk(implement, { reviewVerdict: 'approve' });
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

  it.skipIf(!tarOk)('regulated archive verification flags malformed audit lines', async () => {
    const ids = await completeRegulatedSession();
    await fs.appendFile(path.join(ids.sessDir, 'audit.jsonl'), '{not-json}\n', 'utf-8');

    const trail = await readAuditTrail(ids.sessDir);
    expect(trail.skipped).toBeGreaterThan(0);

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
      await fs.appendFile(
        path.join(ids.sessDir, 'session-state.json'),
        '\n{"tampered":true}\n',
        'utf-8',
      );

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
      await fs.appendFile(
        path.join(ids.sessDir, 'audit.jsonl'),
        `${JSON.stringify(legacyEvent)}\n`,
        'utf-8',
      );

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
