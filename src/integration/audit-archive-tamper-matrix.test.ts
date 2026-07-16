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
import { computeFingerprint, sessionDir, verifyArchive } from '../adapters/workspace/index.js';
import { verifyChain } from '../audit/integrity.js';
import { computeCanonicalEventDigest } from '../audit/canonical-digest.js';
import { computeChainHash, type ChainedAuditEvent } from '../audit/types.js';
import { runWithAdapterLoggerAsync, type AdapterLogger } from '../logging/adapter-logger.js';
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
      id: 'initiator',
      email: 'initiator@example.com',
      displayName: null,
      source: 'claim' as const,
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

const actorMock = await import('../adapters/actor.js');

const tarOk = await isTarAvailable();

let ws: TestWorkspace;
let ctx: TestToolContext;

async function callOk(tool: ToolDefinition, args: unknown): Promise<Record<string, unknown>> {
  const { sessDir } = await getSessionPaths();
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
    await callOk(plan, { reviewVerdict: 'accept' });
  }

  vi.mocked(actorMock.resolveActor).mockResolvedValue({
    id: 'reviewer',
    email: 'reviewer@example.com',
    displayName: null,
    source: 'claim',
    assurance: 'claim_validated',
  });
  await callOk(decision, { verdict: 'approve', rationale: 'plan approved' });

  // Run all active verification checks for the current phase (VALIDATION baseline
  // or IMPL_VALIDATION post-implementation). Discovery detects TypeScript →
  // activeChecks=['typecheck'] → pass via run_check.
  const runActiveChecks = async (): Promise<void> => {
    const ids = await getSessionPaths();
    const st = await readState(ids.sessDir);
    if (st && st.activeChecks.length > 0) {
      for (const kind of st.activeChecks) {
        await callOk(run_check, { kind });
      }
    }
  };
  await runActiveChecks(); // VALIDATION → IMPLEMENTATION

  await callOk(implement, {});
  await runActiveChecks(); // IMPL_VALIDATION → IMPL_REVIEW (re-run checks on the fixed code)
  for (let i = 0; i < 8 && (await currentPhase()) !== 'EVIDENCE_REVIEW'; i++) {
    await callOk(review_implementation, { reviewVerdict: 'accept' });
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
    clearUserDecisionIntents();
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
    const logs: Array<{
      level: string;
      service: string;
      message: string;
      extra?: Record<string, unknown>;
    }> = [];
    const logger: AdapterLogger = {
      info: (service, message, extra) => logs.push({ level: 'info', service, message, extra }),
      warn: (service, message, extra) => logs.push({ level: 'warn', service, message, extra }),
      error: (service, message, extra) => logs.push({ level: 'error', service, message, extra }),
    };
    const verification = await runWithAdapterLoggerAsync(logger, () =>
      verifyArchive(ids.fingerprint, ctx.sessionID),
    );
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
    expect(
      logs.some(
        (entry) =>
          entry.level === 'error' &&
          entry.service === 'archive' &&
          typeof entry.extra?.eventId === 'string' &&
          typeof entry.extra.expectedChainHash === 'string' &&
          entry.extra.actualChainHash === '0'.repeat(64) &&
          !('event' in entry.extra),
      ),
    ).toBe(true);
  });

  it.skipIf(!tarOk)('nested audit event content tamper -> chain integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = events[events.length - 1]!;
    const detail = last.detail as Record<string, unknown>;
    events[events.length - 1] = {
      ...last,
      detail: {
        ...detail,
        nestedTamper: { verdict: 'reject', depth: { changed: true } },
      },
    };
    await fs.writeFile(
      path.join(ids.sessDir, 'audit.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf-8',
    );

    const chainResult = verifyChain(events, { strict: true });
    expect(chainResult.valid).toBe(false);
    expect(chainResult.reason).toBe('CHAIN_BREAK');
    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.code === 'audit_chain_invalid')).toBe(true);
  });

  it.skipIf(!tarOk)(
    'regulated nested content tamper with re-sealed chain -> TSA verification failure',
    async () => {
      const ids = await completeRegulatedSession();
      const lines = await readAuditLines(ids.sessDir);
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const last = events[events.length - 1]! as unknown as ChainedAuditEvent;
      const originalDigest = computeCanonicalEventDigest(Object.fromEntries(Object.entries(last)));
      const { chainHash: _originalChainHash, ...lastWithoutHash } = last;
      const stampedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...lastWithoutHash,
        canonicalEventDigest: originalDigest,
        timestampEvidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          resolvedAt: last.timestamp,
          tsa: {
            tokenDerBase64: 'trusted-token-material-not-logged',
            receivedAt: last.timestamp,
            messageImprint: originalDigest,
            digestAlgorithm: 'sha256',
            verificationStatus: 'unchecked',
          },
        },
      };
      const stamped = {
        ...stampedBody,
        chainHash: computeChainHash(last.prevHash, stampedBody),
      };
      const { chainHash: _chainHash, ...stampedWithoutHash } = stamped;
      const tamperedBody = {
        ...stampedWithoutHash,
        detail: {
          ...stamped.detail,
          nestedTamper: { verdict: 'reject', depth: { changed: true } },
        },
      };
      const resealedTamper = {
        ...tamperedBody,
        canonicalEventDigest: computeCanonicalEventDigest(tamperedBody),
      };
      events[events.length - 1] = {
        ...resealedTamper,
        chainHash: computeChainHash(last.prevHash, resealedTamper),
      } as unknown as Record<string, unknown>;
      await fs.writeFile(
        path.join(ids.sessDir, 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      );

      const chainResult = verifyChain(events, { strict: true, strictTimestamps: true });
      expect(chainResult.valid).toBe(false);
      expect(chainResult.reason).toBe('TOKEN_VERIFICATION_REQUIRED');
      const logs: Array<{
        level: string;
        service: string;
        message: string;
        extra?: Record<string, unknown>;
      }> = [];
      const logger: AdapterLogger = {
        info: (service, message, extra) => logs.push({ level: 'info', service, message, extra }),
        warn: (service, message, extra) => logs.push({ level: 'warn', service, message, extra }),
        error: (service, message, extra) => logs.push({ level: 'error', service, message, extra }),
      };

      const verification = await runWithAdapterLoggerAsync(logger, () =>
        verifyArchive(ids.fingerprint, ctx.sessionID),
      );

      expect(verification.passed).toBe(false);
      expect(
        verification.findings.some(
          (f) => f.code === 'tsa_verification_failed' && f.severity === 'error',
        ),
      ).toBe(true);
      expect(
        logs.some(
          (entry) =>
            entry.level === 'error' &&
            entry.service === 'archive' &&
            entry.extra?.reason === 'token_verification_required' &&
            typeof entry.extra.eventId === 'string' &&
            !('tokenDerBase64' in entry.extra) &&
            !('messageImprint' in entry.extra),
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!tarOk)(
    'regulated nested content tamper with coordinated imprint edit -> still TOKEN_VERIFICATION_REQUIRED',
    async () => {
      const ids = await completeRegulatedSession();
      const lines = await readAuditLines(ids.sessDir);
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const last = events[events.length - 1]! as unknown as ChainedAuditEvent;
      const originalDigest = computeCanonicalEventDigest(Object.fromEntries(Object.entries(last)));
      const { chainHash: _originalChainHash, ...lastWithoutHash } = last;
      const stampedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...lastWithoutHash,
        canonicalEventDigest: originalDigest,
        timestampEvidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          resolvedAt: last.timestamp,
          tsa: {
            tokenDerBase64: 'trusted-token-material-not-logged',
            receivedAt: last.timestamp,
            messageImprint: originalDigest,
            digestAlgorithm: 'sha256',
            verificationStatus: 'unchecked',
          },
        },
      };
      const stamped = {
        ...stampedBody,
        chainHash: computeChainHash(last.prevHash, stampedBody),
      };
      const { chainHash: _chainHash, ...stampedWithoutHash } = stamped;
      const tamperedBody = {
        ...stampedWithoutHash,
        detail: {
          ...stamped.detail,
          nestedTamper: { verdict: 'reject', depth: { changed: true } },
        },
      };
      const attackerDigest = computeCanonicalEventDigest(tamperedBody);
      const coordinatedTamper: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...tamperedBody,
        canonicalEventDigest: attackerDigest,
        timestampEvidence: {
          ...stampedBody.timestampEvidence!,
          tsa: {
            ...stampedBody.timestampEvidence!.tsa!,
            messageImprint: attackerDigest,
          },
        },
      };
      events[events.length - 1] = {
        ...coordinatedTamper,
        chainHash: computeChainHash(last.prevHash, coordinatedTamper),
      } as unknown as Record<string, unknown>;
      await fs.writeFile(
        path.join(ids.sessDir, 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      );

      const chainResult = verifyChain(events, { strict: true, strictTimestamps: true });
      expect(chainResult.valid).toBe(false);
      expect(chainResult.reason).toBe('TOKEN_VERIFICATION_REQUIRED');
    },
  );

  it.skipIf(!tarOk)('pre-v2 chained audit format -> explicit legacy archive finding', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = { ...events[events.length - 1]! };
    delete last.auditFormatVersion;
    events[events.length - 1] = last;
    await fs.writeFile(
      path.join(ids.sessDir, 'audit.jsonl'),
      `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
      'utf-8',
    );

    const chainResult = verifyChain(events, { strict: true });
    expect(chainResult.valid).toBe(false);
    expect(chainResult.reason).toBe('LEGACY_AUDIT_CHAIN_NOT_VERIFIABLE_WITH_V2');
    const verification = await verifyArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.code === 'audit_chain_legacy_format')).toBe(true);
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

  it.skipIf(!tarOk)(
    'manifest policyMode flipped to weaken strict verification -> verify fail (#420)',
    async () => {
      const ids = await completeRegulatedSession();
      const manifestPath = path.join(ids.sessDir, 'archive-manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      // Attacker flips the unsigned mode field to disable strict verification.
      // The integrity-covered authority (state.policySnapshot.mode) still says regulated.
      expect(manifest.policyMode).toBe('regulated');
      manifest.policyMode = 'team';
      await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');

      const logs: Array<{ level: string; service: string; extra?: Record<string, unknown> }> = [];
      const logger: AdapterLogger = {
        info: (service, _m, extra) => logs.push({ level: 'info', service, extra }),
        warn: (service, _m, extra) => logs.push({ level: 'warn', service, extra }),
        error: (service, _m, extra) => logs.push({ level: 'error', service, extra }),
      };
      const verification = await runWithAdapterLoggerAsync(logger, () =>
        verifyArchive(ids.fingerprint, ctx.sessionID),
      );

      expect(verification.passed).toBe(false);
      expect(
        verification.findings.some(
          (f) => f.code === 'manifest_policy_mode_mismatch' && f.severity === 'error',
        ),
      ).toBe(true);
      expect(
        logs.some(
          (entry) =>
            entry.level === 'error' &&
            entry.service === 'archive' &&
            entry.extra?.reason === 'manifest_policy_mode_mismatch' &&
            entry.extra?.manifestMode === 'team' &&
            entry.extra?.stateMode === 'regulated',
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!tarOk)(
    'audit trail tail truncation -> verify fail with explicit code (#420)',
    async () => {
      const ids = await completeRegulatedSession();
      const lines = await readAuditLines(ids.sessDir);
      expect(lines.length).toBeGreaterThan(1);
      // Drop the final event(s): a prefix of a valid hash-chain is still chain-valid,
      // so only a signed head+count anchor can expose the missing tail.
      const truncated = lines.slice(0, lines.length - 1);
      await fs.writeFile(
        path.join(ids.sessDir, 'audit.jsonl'),
        `${truncated.join('\n')}\n`,
        'utf-8',
      );

      const logs: Array<{ level: string; service: string; extra?: Record<string, unknown> }> = [];
      const logger: AdapterLogger = {
        info: (service, _m, extra) => logs.push({ level: 'info', service, extra }),
        warn: (service, _m, extra) => logs.push({ level: 'warn', service, extra }),
        error: (service, _m, extra) => logs.push({ level: 'error', service, extra }),
      };
      const verification = await runWithAdapterLoggerAsync(logger, () =>
        verifyArchive(ids.fingerprint, ctx.sessionID),
      );

      expect(verification.passed).toBe(false);
      expect(
        verification.findings.some(
          (f) => f.code === 'audit_chain_truncated' && f.severity === 'error',
        ),
      ).toBe(true);
      expect(
        logs.some(
          (entry) =>
            entry.level === 'error' &&
            entry.service === 'archive' &&
            entry.extra?.reason === 'audit_chain_truncated' &&
            entry.extra?.expectedCount === lines.length &&
            entry.extra?.actualCount === truncated.length,
        ),
      ).toBe(true);
    },
  );

  it.skipIf(!tarOk)('evidence file tamper after archive -> verify fail', async () => {
    const ids = await completeRegulatedSession();
    await fs.appendFile(
      path.join(ids.sessDir, 'archive-manifest.json'),
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
