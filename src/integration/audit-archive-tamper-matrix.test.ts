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
import { readState } from '../adapters/persistence.js';
import { computeFingerprint, sessionDir, verifyArchive } from '../adapters/workspace/index.js';
import { verifyChain } from '../audit/integrity.js';

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
      id: 'initiator',
      email: 'initiator@example.com',
      displayName: null,
      source: 'claim' as const,
      assurance: 'claim_validated' as const,
    }),
  };
});

const actorMock = await import('../adapters/actor.js');

const tarOk = await isTarAvailable();

let ws: TestWorkspace;
let ctx: TestToolContext;

async function callOk(
  tool: { execute: (args: unknown, context: TestToolContext) => Promise<string> },
  args: unknown,
): Promise<Record<string, unknown>> {
  const { sessDir } = await getSessionPaths();
  const finalArgs = await withStrictReviewFindings(sessDir, args);
  const result = parseToolResult(await tool.execute(finalArgs, ctx));
  if (result.error) {
    throw new Error(`Tool returned error: ${result.code} - ${result.message}`);
  }
  return result;
}

async function currentPhase(): Promise<string> {
  return parseToolResult(await status.execute({}, ctx)).phase as string;
}

async function getSessionPaths(): Promise<{
  fingerprint: string;
  sessDir: string;
  archiveSidecar: string;
}> {
  const fp = await computeFingerprint(ctx.worktree);
  const sessDir = sessionDir(fp.fingerprint, ctx.sessionID);
  const archiveSidecar = path.join(
    process.env.OPENCODE_CONFIG_DIR ?? '',
    'workspaces',
    fp.fingerprint,
    'sessions',
    'archive',
    `${ctx.sessionID}.tar.gz.sha256`,
  );
  return { fingerprint: fp.fingerprint, sessDir, archiveSidecar };
}

async function completeRegulatedSession(): Promise<{
  fingerprint: string;
  sessDir: string;
  archiveSidecar: string;
}> {
  await callOk(hydrate, { policyMode: 'regulated', profileId: 'baseline' });
  await callOk(ticket, { text: 'Tamper matrix ticket', source: 'user' });
  await callOk(plan, { planText: '## Plan\n1. Build\n2. Verify' });

  for (let i = 0; i < 4 && (await currentPhase()) !== 'PLAN_REVIEW'; i++) {
    await callOk(plan, { selfReviewVerdict: 'approve' });
  }

  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: 'reviewer',
    email: 'reviewer@example.com',
    displayName: null,
    source: 'claim',
    assurance: 'claim_validated',
  });
  await callOk(decision, { verdict: 'approve', rationale: 'plan approved' });

  await callOk(validate, {
    results: [
      { checkId: 'test_quality', passed: true, detail: 'OK' },
      { checkId: 'rollback_safety', passed: true, detail: 'OK' },
    ],
  });

  await callOk(implement, {});
  for (let i = 0; i < 8 && (await currentPhase()) !== 'EVIDENCE_REVIEW'; i++) {
    await callOk(implement, { reviewVerdict: 'approve' });
  }

  await callOk(decision, { verdict: 'approve', rationale: 'evidence approved' });
  expect(await currentPhase()).toBe('COMPLETE');

  return getSessionPaths();
}

async function readAuditLines(sessDir: string): Promise<string[]> {
  const raw = await fs.readFile(path.join(sessDir, 'audit.jsonl'), 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

describe('audit/archive tamper matrix', () => {
  beforeEach(async () => {
    ws = await createTestWorkspace();
    ctx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: crypto.randomUUID(),
    });
  });

  afterEach(async () => {
    vi.mocked(actorMock.resolveActor).mockReset().mockResolvedValue({
      id: 'initiator',
      email: 'initiator@example.com',
      displayName: null,
      source: 'claim',
      assurance: 'claim_validated',
    });
    vi.clearAllMocks();
    await ws.cleanup();
  });

  it.skipIf(!tarOk)('audit line deleted -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    lines.splice(1, 1);
    await fs.writeFile(path.join(ids.sessDir, 'audit.jsonl'), `${lines.join('\n')}\n`, 'utf-8');

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('audit line reordered -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const swapped = [lines[1], lines[0], ...lines.slice(2)].filter(Boolean);
    await fs.writeFile(path.join(ids.sessDir, 'audit.jsonl'), `${swapped.join('\n')}\n`, 'utf-8');

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('eventHash/chainHash tamper -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    events[events.length - 1] = {
      ...events[events.length - 1],
      chainHash: '0'.repeat(64),
    };
    await fs.writeFile(
      path.join(ids.sessDir, 'audit.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf-8',
    );

    expect(verifyChain(events, { strict: true }).valid).toBe(false);
    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('prevHash tamper -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    events[events.length - 1] = {
      ...events[events.length - 1],
      prevHash: 'f'.repeat(64),
    };
    await fs.writeFile(
      path.join(ids.sessDir, 'audit.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf-8',
    );

    expect(verifyChain(events, { strict: true }).valid).toBe(false);
    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('legacy unchained event inserted -> strict regulated fail', async () => {
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

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('malformed JSONL line -> visible integrity issue', async () => {
    const ids = await completeRegulatedSession();
    await fs.appendFile(path.join(ids.sessDir, 'audit.jsonl'), '{not-json}\n', 'utf-8');

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.code === 'audit_chain_invalid')).toBe(true);
  });

  it.skipIf(!tarOk)('archive manifest digest tamper -> verify fail', async () => {
    const ids = await completeRegulatedSession();
    const manifestPath = path.join(ids.sessDir, 'archive-manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
      string,
      unknown
    >;
    manifest.contentDigest = '0'.repeat(64);
    await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('evidence file tamper after archive -> verify fail', async () => {
    const ids = await completeRegulatedSession();
    await fs.appendFile(
      path.join(ids.sessDir, 'session-state.json'),
      '\n{"tampered":true}\n',
      'utf-8',
    );

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('missing .sha256 sidecar in regulated mode -> verify fail', async () => {
    const ids = await completeRegulatedSession();
    await fs.unlink(ids.archiveSidecar);

    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_missing', severity: 'error' }),
    );
  });

  it.skipIf(!tarOk)(
    'regulated tamper verification fails while persisted workflow phase remains complete',
    async () => {
      const ids = await completeRegulatedSession();
      await fs.appendFile(path.join(ids.sessDir, 'audit.jsonl'), '{not-json}\n', 'utf-8');

      const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
      const state = await readState(ids.sessDir);

      expect(verification.passed).toBe(false);
      expect(verification.findings.length).toBeGreaterThan(0);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('COMPLETE');
    },
  );
});
