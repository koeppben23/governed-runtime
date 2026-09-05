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
import { readState, writeState } from '../adapters/persistence.js';
import type { SessionState } from '../state/schema.js';
import { computeFingerprint, sessionDir } from '../adapters/workspace/index.js';
import { verifyRegulatedArchive } from '../adapters/workspace/archive-verify-chain.js';
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
    isGitRepo: vi.fn().mockResolvedValue(true),
    isGitRepoStrict: vi.fn().mockResolvedValue(true),
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
    headCommitFull: vi.fn().mockResolvedValue('d'.repeat(40)),
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

/** A well-formed but different FlowGuard session identity for rebinding tests. */
const FOREIGN_SESSION_ID = 'bbbbbbbb-0000-4000-8000-000000000001';

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
    `regulated-${ctx.sessionID}.tar.gz.sha256`,
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
  await callOk(plan, { planText: '## Plan\n1. Build\n2. Verify', targetPaths: ['docs/test.md'] });

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

/**
 * The self-contained audit snapshot inside the published archive — the exact
 * trail the archive verification evaluates. Post-archive live projections
 * (publication bindings, reconciled archive-status writes) are intentionally
 * absent here, so tamper targets must come from the archive itself.
 */
async function readArchivedAuditEvents(ids: {
  archiveSidecar: string;
}): Promise<Record<string, unknown>[]> {
  const archivePath = ids.archiveSidecar.slice(0, -'.sha256'.length);
  const { stdout } = await promisify(execFile)('tar', [
    'xOf',
    archivePath,
    `${ctx.sessionID}/audit/audit.jsonl`,
  ]);
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function mutateArchive(
  ids: { archiveSidecar: string },
  mutate: (root: string) => Promise<void>,
  additionalMembers: readonly string[] = [],
): Promise<void> {
  const archivePath = ids.archiveSidecar.slice(0, -'.sha256'.length);
  const stagingRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'archive-tamper-'));
  try {
    await promisify(execFile)('tar', ['xzf', archivePath, '-C', stagingRoot]);
    const root = path.join(stagingRoot, ctx.sessionID);
    const manifest = JSON.parse(
      await fs.readFile(path.join(root, 'archive-manifest.json'), 'utf-8'),
    ) as {
      includedFiles: string[];
    };
    await mutate(root);
    const members = [
      ...manifest.includedFiles.map((file) => path.posix.join(ctx.sessionID, file)),
      path.posix.join(ctx.sessionID, 'archive-manifest.json'),
      ...additionalMembers.map((file) => path.posix.join(ctx.sessionID, file)),
    ];
    await promisify(execFile)('tar', [
      '--format=ustar',
      '-czf',
      archivePath,
      '-C',
      stagingRoot,
      ...members,
    ]);
    const digest = crypto
      .createHash('sha256')
      .update(await fs.readFile(archivePath))
      .digest('hex');
    await fs.writeFile(ids.archiveSidecar, `${digest}  ${path.basename(archivePath)}\n`, 'utf-8');
  } finally {
    await fs.rm(stagingRoot, { recursive: true, force: true });
  }
}

describe('audit/archive tamper matrix', () => {
  beforeEach(async () => {
    ws = await createTestWorkspace();
    // Write config with raw export enabled for archive tamper tests.
    await fs.writeFile(
      path.join(process.env.OPENCODE_CONFIG_DIR ?? '', 'flowguard.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        archive: { redaction: { allowedModes: ['none'], allowRawExport: true } },
      }),
      'utf8',
    );
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
    await mutateArchive(ids, (root) =>
      fs.writeFile(path.join(root, 'audit', 'audit.jsonl'), `${lines.join('\n')}\n`, 'utf-8'),
    );

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('undeclared archive payload -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    await mutateArchive(
      ids,
      (root) => fs.writeFile(path.join(root, 'undeclared.txt'), 'payload', 'utf8'),
      ['undeclared.txt'],
    );

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'unexpected_file', severity: 'error' }),
    );
  });

  it.skipIf(!tarOk)('audit line reordered -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const swapped = [lines[1], lines[0], ...lines.slice(2)].filter(Boolean);
    await mutateArchive(ids, (root) =>
      fs.writeFile(path.join(root, 'audit', 'audit.jsonl'), `${swapped.join('\n')}\n`, 'utf-8'),
    );

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
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
    await mutateArchive(ids, (root) =>
      fs.writeFile(
        path.join(root, 'audit', 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      ),
    );

    expect(verifyChain(events).valid).toBe(false);
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
      verifyRegulatedArchive(ids.fingerprint, ctx.sessionID),
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
    await mutateArchive(ids, (root) =>
      fs.writeFile(
        path.join(root, 'audit', 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      ),
    );

    const chainResult = verifyChain(events);
    expect(chainResult.valid).toBe(false);
    expect(chainResult.reason).toBe('CHAIN_BREAK');
    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.code === 'audit_chain_invalid')).toBe(true);
  });

  it.skipIf(!tarOk)(
    'validly re-sealed trail bound to a foreign session -> archive fails closed',
    async () => {
      // Re-bind EVERY audit event to session B and re-seal hash + semantic
      // digest so the trail is internally valid (verifyChain alone passes).
      // The archived session STATE still carries session A, so the
      // state-bound chain verification must fail closed on the identity
      // mismatch — not on any hash inconsistency.
      const ids = await completeRegulatedSession();
      const lines = await readAuditLines(ids.sessDir);
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      let rechainHead = 'genesis';
      const resealed = events.map((raw) => {
        const { chainHash: _chainHash, ...body } = raw as unknown as ChainedAuditEvent;
        const rebind = {
          ...body,
          prevHash: rechainHead,
          flowguardSessionId: FOREIGN_SESSION_ID,
          semanticEventDigest: computeCanonicalEventDigest({
            ...body,
            prevHash: rechainHead,
            flowguardSessionId: FOREIGN_SESSION_ID,
          } as unknown as Record<string, unknown>),
        };
        const event = {
          ...rebind,
          chainHash: computeChainHash(
            rebind.prevHash,
            rebind as unknown as Omit<ChainedAuditEvent, 'chainHash'>,
          ),
        } as unknown as Record<string, unknown>;
        rechainHead = event.chainHash as string;
        return event;
      });
      await mutateArchive(ids, (root) =>
        fs.writeFile(
          path.join(root, 'audit', 'audit.jsonl'),
          `${resealed.map((e) => JSON.stringify(e)).join('\n')}\n`,
          'utf-8',
        ),
      );

      // Internally consistent: without state binding the trail is valid.
      expect(verifyChain(resealed).valid).toBe(true);

      const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
      expect(verification.passed).toBe(false);
      expect(verification.findings.some((f) => f.code === 'audit_chain_invalid')).toBe(true);
    },
  );

  it.skipIf(!tarOk)(
    'stripped TSA token on a critical event -> tsa_critical archive verification fails closed',
    () => verifyTsaCriticalTokenDowngrade('internal_imprint'),
  );

  it.skipIf(!tarOk)(
    'removed TSA payload on a critical event -> tsa_critical archive verification fails closed',
    () => verifyTsaCriticalTokenDowngrade('no_tsa'),
  );

  /**
   * Adversarial scenario: under tsa_critical policy the external TSA token is
   * the boundary a resealer cannot regenerate. Remove the external anchoring
   * (`internal_imprint`: token stripped to the empty string, or `no_tsa`: the
   * whole tsa payload removed), recompute the local digests and chain hash so
   * the trail is internally consistent, and prove that the archive
   * verification still fails closed with a dedicated policy downgrade
   * instead of accepting self-resealable evidence.
   */
  async function verifyTsaCriticalTokenDowngrade(
    variant: 'internal_imprint' | 'no_tsa',
  ): Promise<void> {
    const ids = await completeRegulatedSession();
    const state = await readState(ids.sessDir);
    expect(state).not.toBeNull();
    const tsaCriticalState: SessionState = {
      ...state!,
      policySnapshot: {
        ...state!.policySnapshot,
        audit: {
          ...state!.policySnapshot.audit,
          timestampAssurance: {
            enabled: true,
            mode: 'tsa_critical',
            strict: true,
            criticalEvents: ['decision', 'lifecycle'],
            tsaUrl: 'https://tsa.example.test',
            trustAnchors: ['not a pem certificate'],
            ntpServers: ['pool.ntp.org'],
            ntpDriftThresholdMs: 30000,
            tsaTimeoutMs: 10000,
          },
        },
      },
    };

    const events = await readArchivedAuditEvents(ids);
    const last = events[events.length - 1] as unknown as ChainedAuditEvent;
    const { chainHash: _originalChainHash, ...lastWithoutHash } = last;
    const strippedBody = {
      ...lastWithoutHash,
      event: 'lifecycle:session_completed',
    };
    const imprint = computeCanonicalEventDigest(strippedBody);
    const resealedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
      ...strippedBody,
      semanticEventDigest: imprint,
      timestampEvidence:
        variant === 'internal_imprint'
          ? {
              status: 'tsa_stamped',
              source: 'tsa',
              resolvedAt: last.occurredAt,
              tsa: {
                tokenDerBase64: '',
                receivedAt: last.occurredAt,
                messageImprint: imprint,
                digestAlgorithm: 'sha256',
                verificationStatus: 'unchecked',
              },
            }
          : {
              status: 'tsa_stamped',
              source: 'tsa',
              resolvedAt: last.occurredAt,
            },
    };
    events[events.length - 1] = {
      ...resealedBody,
      chainHash: computeChainHash(last.prevHash, resealedBody),
    } as unknown as Record<string, unknown>;
    await mutateArchive(ids, async (root) => {
      await fs.writeFile(
        path.join(root, 'audit', 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      );
      await writeState(path.join(root, 'state'), tsaCriticalState);
    });

    // Internally consistent: the chain-level verification accepts the
    // evidence-less/imprint-only model — the policy boundary must reject it.
    expect(verifyChain(events).valid).toBe(true);

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(
      verification.findings.some(
        (f) => f.code === 'tsa_token_required_by_policy' && f.severity === 'error',
      ),
    ).toBe(true);
  }

  it.skipIf(!tarOk)(
    'regulated nested content tamper with re-sealed chain -> missing timestamp evidence wins over deferred verification',
    async () => {
      const ids = await completeRegulatedSession();
      const events = await readArchivedAuditEvents(ids);
      const last = events[events.length - 1]! as unknown as ChainedAuditEvent;
      const originalDigest = computeCanonicalEventDigest(Object.fromEntries(Object.entries(last)));
      const { chainHash: _originalChainHash, ...lastWithoutHash } = last;
      const stampedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...lastWithoutHash,
        semanticEventDigest: originalDigest,
        timestampEvidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          resolvedAt: last.occurredAt,
          tsa: {
            tokenDerBase64: 'trusted-token-material-not-logged',
            receivedAt: last.occurredAt,
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
        semanticEventDigest: computeCanonicalEventDigest(tamperedBody),
      };
      events[events.length - 1] = {
        ...resealedTamper,
        chainHash: computeChainHash(last.prevHash, resealedTamper),
      } as unknown as Record<string, unknown>;
      await mutateArchive(ids, (root) =>
        fs.writeFile(
          path.join(root, 'audit', 'audit.jsonl'),
          `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
          'utf-8',
        ),
      );

      const chainResult = verifyChain(events, { strictTimestamps: true });
      expect(chainResult.valid).toBe(false);
      expect(chainResult.reason).toBe('TIMESTAMP_EVIDENCE_MISSING');
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
        verifyRegulatedArchive(ids.fingerprint, ctx.sessionID),
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
      ).toBe(false);
    },
  );

  it.skipIf(!tarOk)(
    'regulated nested content tamper with coordinated imprint edit -> missing timestamp evidence wins over deferred verification',
    async () => {
      const ids = await completeRegulatedSession();
      const lines = await readAuditLines(ids.sessDir);
      const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
      const last = events[events.length - 1]! as unknown as ChainedAuditEvent;
      const originalDigest = computeCanonicalEventDigest(Object.fromEntries(Object.entries(last)));
      const { chainHash: _originalChainHash, ...lastWithoutHash } = last;
      const stampedBody: Omit<ChainedAuditEvent, 'chainHash'> = {
        ...lastWithoutHash,
        semanticEventDigest: originalDigest,
        timestampEvidence: {
          status: 'tsa_stamped',
          source: 'tsa',
          resolvedAt: last.occurredAt,
          tsa: {
            tokenDerBase64: 'trusted-token-material-not-logged',
            receivedAt: last.occurredAt,
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
        semanticEventDigest: attackerDigest,
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
      await mutateArchive(ids, (root) =>
        fs.writeFile(
          path.join(root, 'audit', 'audit.jsonl'),
          `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
          'utf-8',
        ),
      );

      const chainResult = verifyChain(events, { strictTimestamps: true });
      expect(chainResult.valid).toBe(false);
      expect(chainResult.reason).toBe('TIMESTAMP_EVIDENCE_MISSING');
    },
  );

  it.skipIf(!tarOk)('pre-v3 audit record -> envelope-invalid archive finding', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    const last = { ...events[events.length - 1]! };
    delete last.auditFormatVersion;
    events[events.length - 1] = last;
    await mutateArchive(ids, (root) =>
      fs.writeFile(
        path.join(root, 'audit', 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      ),
    );

    const chainResult = verifyChain(events);
    expect(chainResult.valid).toBe(false);
    expect(chainResult.reason).toBe('AUDIT_ENVELOPE_INVALID');
    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.code === 'audit_chain_invalid_event')).toBe(true);
  });

  it.skipIf(!tarOk)('prevHash tamper -> integrity failure', async () => {
    const ids = await completeRegulatedSession();
    const lines = await readAuditLines(ids.sessDir);
    const events = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    events[events.length - 1] = {
      ...events[events.length - 1],
      prevHash: 'f'.repeat(64),
    };
    await mutateArchive(ids, (root) =>
      fs.writeFile(
        path.join(root, 'audit', 'audit.jsonl'),
        `${events.map((e) => JSON.stringify(e)).join('\n')}\n`,
        'utf-8',
      ),
    );

    expect(verifyChain(events).valid).toBe(false);
    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('unchained non-v3 event inserted -> strict regulated fail', async () => {
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
    await mutateArchive(ids, (root) =>
      fs.appendFile(
        path.join(root, 'audit', 'audit.jsonl'),
        `${JSON.stringify(legacyEvent)}\n`,
        'utf-8',
      ),
    );

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('malformed JSONL line -> visible integrity issue', async () => {
    const ids = await completeRegulatedSession();
    await mutateArchive(ids, (root) =>
      fs.appendFile(path.join(root, 'audit', 'audit.jsonl'), '{not-json}\n', 'utf-8'),
    );

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(
      verification.findings.some(
        (f) => f.code === 'audit_chain_invalid_event' || f.code === 'audit_chain_invalid',
      ),
    ).toBe(true);
  });

  it.skipIf(!tarOk)(
    'schema-invalid current-v3 record -> audit_chain_invalid_event archive finding',
    async () => {
      // A record that violates the canonical audit-chain.v3 envelope must be
      // classified as envelope-invalid all the way through the archive read
      // boundary.
      const ids = await completeRegulatedSession();
      const lines = await readAuditLines(ids.sessDir);
      const valid = JSON.parse(lines[0]!) as Record<string, unknown>;
      const { actor: _actor, ...envelopeInvalid } = valid;
      await mutateArchive(ids, (root) =>
        fs.appendFile(
          path.join(root, 'audit', 'audit.jsonl'),
          `${JSON.stringify(envelopeInvalid)}\n`,
          'utf-8',
        ),
      );

      const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
      expect(verification.passed).toBe(false);
      expect(verification.findings.some((f) => f.code === 'audit_chain_invalid_event')).toBe(true);
    },
  );

  it.skipIf(!tarOk)('archive manifest digest tamper -> verify fail', async () => {
    const ids = await completeRegulatedSession();
    await mutateArchive(ids, async (root) => {
      const manifestPath = path.join(root, 'archive-manifest.json');
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
        string,
        unknown
      >;
      manifest.contentDigest = '0'.repeat(64);
      await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
    });

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)(
    'manifest policyMode flipped to weaken strict verification -> verify fail (#420)',
    async () => {
      const ids = await completeRegulatedSession();
      await mutateArchive(ids, async (root) => {
        const manifestPath = path.join(root, 'archive-manifest.json');
        const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8')) as Record<
          string,
          unknown
        >;
        // Attacker flips the unsigned mode field to disable strict verification.
        // The integrity-covered authority (state.policySnapshot.mode) still says regulated.
        expect(manifest.policyMode).toBe('regulated');
        manifest.policyMode = 'team';
        await fs.writeFile(manifestPath, JSON.stringify(manifest), 'utf-8');
      });

      const logs: Array<{ level: string; service: string; extra?: Record<string, unknown> }> = [];
      const logger: AdapterLogger = {
        info: (service, _m, extra) => logs.push({ level: 'info', service, extra }),
        warn: (service, _m, extra) => logs.push({ level: 'warn', service, extra }),
        error: (service, _m, extra) => logs.push({ level: 'error', service, extra }),
      };
      const verification = await runWithAdapterLoggerAsync(logger, () =>
        verifyRegulatedArchive(ids.fingerprint, ctx.sessionID),
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
      let lines: string[] = [];
      let truncated: string[] = [];
      // Drop the final event(s): a prefix of a valid hash-chain is still chain-valid,
      // so only a signed head+count anchor can expose the missing tail.
      await mutateArchive(ids, async (root) => {
        lines = await readAuditLines(path.join(root, 'audit'));
        expect(lines.length).toBeGreaterThan(1);
        truncated = lines.slice(0, lines.length - 1);
        await fs.writeFile(
          path.join(root, 'audit', 'audit.jsonl'),
          `${truncated.join('\n')}\n`,
          'utf-8',
        );
      });

      const logs: Array<{ level: string; service: string; extra?: Record<string, unknown> }> = [];
      const logger: AdapterLogger = {
        info: (service, _m, extra) => logs.push({ level: 'info', service, extra }),
        warn: (service, _m, extra) => logs.push({ level: 'warn', service, extra }),
        error: (service, _m, extra) => logs.push({ level: 'error', service, extra }),
      };
      const verification = await runWithAdapterLoggerAsync(logger, () =>
        verifyRegulatedArchive(ids.fingerprint, ctx.sessionID),
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
    await mutateArchive(ids, (root) =>
      fs.appendFile(path.join(root, 'archive-manifest.json'), '\n{"tampered":true}\n', 'utf-8'),
    );

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings.some((f) => f.severity === 'error')).toBe(true);
  });

  it.skipIf(!tarOk)('missing .sha256 sidecar in regulated mode -> verify fail', async () => {
    const ids = await completeRegulatedSession();
    await fs.unlink(ids.archiveSidecar);

    const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
    expect(verification.passed).toBe(false);
    expect(verification.findings).toContainEqual(
      expect.objectContaining({ code: 'archive_checksum_missing', severity: 'error' }),
    );
  });

  it.skipIf(!tarOk)(
    'regulated tamper verification fails while persisted workflow phase remains complete',
    async () => {
      const ids = await completeRegulatedSession();
      await mutateArchive(ids, (root) =>
        fs.appendFile(path.join(root, 'audit', 'audit.jsonl'), '{not-json}\n', 'utf-8'),
      );

      const verification = await verifyRegulatedArchive(ids.fingerprint, ctx.sessionID);
      const state = await readState(ids.sessDir);

      expect(verification.passed).toBe(false);
      expect(verification.findings.length).toBeGreaterThan(0);
      expect(state).not.toBeNull();
      expect(state!.phase).toBe('COMPLETE');
    },
  );
});
