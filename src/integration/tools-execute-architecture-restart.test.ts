/**
 * @module integration/tools-execute-architecture-restart.test
 * @description Tool-layer tests for architecture review restarts after a
 * blocked review obligation (claim validation and fail-closed recovery).
 *
 * Scope: architecture restart path in the tool layer against real filesystem
 * persistence with OPENCODE_CONFIG_DIR redirected to a temp directory.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  withTestEnv,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate, architecture } from './tools/index.js';
import { readState, writeState } from '../adapters/persistence.js';
import { readAuditTrail } from '../adapters/persistence-audit.js';
import { blockObligation } from './review/obligations/obligation-state.js';
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
    headCommitFull: vi.fn().mockResolvedValue('d'.repeat(40)),
  };
});

vi.mock('../adapters/frozen-repository.js', async (importOriginal) => {
  const { frozenRepositoryAdapterMock } = await import('./adapter-mock-test-helpers.js');
  return frozenRepositoryAdapterMock(
    await importOriginal<typeof import('../adapters/frozen-repository.js')>(),
  );
});

vi.mock('../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      source: 'env',
      assurance: 'best_effort',
    }),
  };
});

const adrText =
  '## Context\nA database is needed.\n\n## Decision\nUse PostgreSQL.\n\n## Consequences\nMust maintain DB infra.';

const planShapedClaim = {
  statement: 'missing ids return 404',
  critical: true,
  authoritySectionId: 'decision',
  claimScope: 'specific_behavior',
  expectedCheckId: 'test',
};

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
  cleanupEnv();
  vi.clearAllMocks();
  await ws.cleanup();
});

async function hydrateSession(policyMode = 'team'): Promise<void> {
  await hydrate.execute({ policyMode }, ctx);
}

async function currentSessionDir(): Promise<string> {
  const fp = await computeFingerprint(ws.tmpDir);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

/** Submit an ADR, then block its pending review obligation. */
async function submitAndBlock(): Promise<{
  sessDir: string;
  state: NonNullable<Awaited<ReturnType<typeof readState>>>;
}> {
  await hydrateSession();
  await architecture.execute({ title: 'Null-safety', adrText, targetPaths: ['docs/test.md'] }, ctx);
  const sessDir = await currentSessionDir();
  const pending = await readState(sessDir);
  if (!pending) throw new Error('missing state after architecture submission');
  const obligation = pending.reviewAssurance?.obligations.find(
    (item) => item.obligationType === 'architecture' && item.status === 'pending',
  );
  if (!obligation) throw new Error('missing pending architecture obligation');
  await writeState(sessDir, blockObligation(pending, obligation.obligationId, 'TEST_BLOCKED'));
  return { sessDir, state: pending };
}

describe('architecture restart after a blocked review', () => {
  it('blocks plan-shaped claims without state or audit mutation', async () => {
    const { sessDir } = await submitAndBlock();
    const before = await readState(sessDir);
    const beforeAudit = await readAuditTrail(sessDir);

    const raw = await architecture.execute(
      {
        title: 'Null-safety revised',
        adrText: `${adrText}\n\nAdditional constraint text.`,
        claims: [planShapedClaim],
        targetPaths: ['docs/test.md'],
      },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('ARCHITECTURE_CLAIM_INVALID');
    expect(String(result.message)).toContain('requiredReviewEvidence');

    // Fail-closed: no new obligation/attempt, no state or audit mutation.
    expect(await readState(sessDir)).toEqual(before);
    expect(await readAuditTrail(sessDir)).toEqual(beforeAudit);
  });

  it('blocks plan-shaped claims even when the ADR revision is unchanged', async () => {
    const { sessDir } = await submitAndBlock();
    const before = await readState(sessDir);

    const raw = await architecture.execute(
      {
        title: 'Null-safety',
        adrText,
        claims: [planShapedClaim],
        targetPaths: ['docs/test.md'],
      },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBe(true);
    expect(result.code).toBe('ARCHITECTURE_CLAIM_INVALID');
    expect(await readState(sessDir)).toEqual(before);
  });

  it('accepts a claim-only revision with schema-valid claims', async () => {
    const { sessDir } = await submitAndBlock();

    const raw = await architecture.execute(
      {
        title: 'Null-safety',
        adrText,
        claims: [
          {
            statement: 'the decision keeps service data durable',
            critical: true,
            authoritySectionId: 'decision',
            requiredReviewEvidence: ['architecture-review'],
          },
        ],
        targetPaths: ['docs/test.md'],
      },
      ctx,
    );
    const result = parseToolResult(raw);
    expect(result.error).toBeUndefined();
    const after = await readState(sessDir);
    expect(after!.architecture!.claimDeclarations?.claims).toHaveLength(1);
  });
});
