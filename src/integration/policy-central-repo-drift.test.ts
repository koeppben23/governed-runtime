/**
 * @module integration/policy-central-repo-drift.test
 * @description Attacker-negative test: the central policy minimum decides the
 * governed mode even when the repository config is weaker, and a repository
 * config drift after hydrate cannot weaken the frozen session snapshot. The
 * control run proves that a solo configuration behaves observably differently,
 * so the assertion is carried by the central minimum and the frozen snapshot,
 * not by an unrelated phase or subagent blocker.
 *
 * @test-policy BAD, CORNER
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';

import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  withStrictReviewFindings,
  GIT_MOCK_DEFAULTS,
  withTestEnv,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { hydrate, ticket, plan } from './tools/index.js';
import { readState } from '../adapters/persistence.js';
import { computeFingerprint, sessionDir } from '../adapters/workspace/index.js';
import { writeRepoConfig } from '../adapters/persistence-config.js';
import { FlowGuardConfigSchema } from '../config/flowguard-config.js';

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

const cleanups: Array<() => void | Promise<void>> = [];

afterEach(async () => {
  await Promise.all(
    cleanups.splice(0).map(async (cleanup) => {
      await cleanup();
    }),
  );
});

let ws: TestWorkspace;
let ctx: TestToolContext;

async function setupWorkspace(): Promise<void> {
  ws = await createTestWorkspace();
  cleanups.push(async () => await ws.cleanup());
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
}

async function repoConfigWithMode(mode: 'solo' | 'team'): Promise<void> {
  await writeRepoConfig(
    ws.tmpDir,
    FlowGuardConfigSchema.parse({ schemaVersion: 'v1', policy: { defaultMode: mode } }),
  );
}

async function sessionState() {
  const fp = await computeFingerprint(ws.tmpDir);
  return await readState(sessionDir(fp.fingerprint, ctx.sessionID));
}

async function driveToPlan(): Promise<Record<string, unknown>> {
  await ticket.execute({ text: 'Central policy drift probe', source: 'user' }, ctx);
  const planned = parseToolResult(
    await plan.execute(
      { planText: '## Plan\n1. Probe central policy drift', targetPaths: ['docs/test.md'] },
      ctx,
    ),
  );
  expect(planned.error).toBeUndefined();
  return planned;
}

describe('central policy vs repository config drift', () => {
  it('BAD: the central team minimum governs even after the repository config is weakened', async () => {
    await setupWorkspace();
    const centralPath = join(ws.tmpDir, 'central-policy.json');
    await fs.writeFile(
      centralPath,
      JSON.stringify({ schemaVersion: 'v1', minimumMode: 'team', version: '2026.04' }),
      'utf-8',
    );
    cleanups.push(withTestEnv({ FLOWGUARD_POLICY_PATH: centralPath }));

    await repoConfigWithMode('solo');
    const hydrated = parseToolResult(await hydrate.execute({ profileId: 'baseline' }, ctx));
    expect(hydrated.error).toBeUndefined();
    expect((await sessionState())?.policySnapshot.mode).toBe('team');

    // Attacker drift: weaken the repository config after hydrate.
    await repoConfigWithMode('solo');

    const planned = await driveToPlan();
    expect(planned.reviewDispatch).toMatchObject({ required: true });

    // The same review acceptance that auto-advances under solo must stop at
    // the human gate under the frozen team snapshot.
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = sessionDir(fp.fingerprint, ctx.sessionID);
    const accepted = parseToolResult(
      await plan.execute(await withStrictReviewFindings(sessDir, { reviewVerdict: 'accept' }), ctx),
    );
    expect(accepted.error).toBeUndefined();

    const state = await sessionState();
    expect(state?.policySnapshot.mode).toBe('team');
    expect(state?.phase).toBe('PLAN_REVIEW');
    expect((state?.reviewAssurance?.obligations ?? []).length).toBeGreaterThan(0);
  });

  it('CORNER: control — a solo repository without central minimum auto-advances past the gate', async () => {
    await setupWorkspace();
    await repoConfigWithMode('solo');

    const hydrated = parseToolResult(await hydrate.execute({ profileId: 'baseline' }, ctx));
    expect(hydrated.error).toBeUndefined();
    expect((await sessionState())?.policySnapshot.mode).toBe('solo');

    const planned = await driveToPlan();
    expect(planned.reviewDispatch).toMatchObject({ required: true });

    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = sessionDir(fp.fingerprint, ctx.sessionID);
    const accepted = parseToolResult(
      await plan.execute(await withStrictReviewFindings(sessDir, { reviewVerdict: 'accept' }), ctx),
    );
    expect(accepted.error).toBeUndefined();

    const state = await sessionState();
    expect(state?.policySnapshot.mode).toBe('solo');
    expect(state?.phase).not.toBe('PLAN_REVIEW');
  });
});
