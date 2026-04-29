import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as crypto from 'node:crypto';

import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from './test-helpers.js';
import { computeFingerprint, sessionDir } from '../adapters/workspace/index.js';
import { readState, statePath } from '../adapters/persistence.js';
import { status } from './tools/index.js';
import { resolvePolicyFromSnapshot } from '../config/policy.js';
import { executeReviewDecision } from '../rails/review-decision.js';

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
      id: 'legacy-reviewer',
      email: 'legacy-reviewer@example.com',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    }),
  };
});

let ws: TestWorkspace;
let ctx: TestToolContext;

async function loadFixture(name: string): Promise<Record<string, unknown>> {
  const file = path.join(process.cwd(), 'src', '__fixtures__', 'session-state', name);
  const raw = await fs.readFile(file, 'utf-8');
  return JSON.parse(raw) as Record<string, unknown>;
}

async function writeFixtureState(name: string): Promise<string> {
  const fixture = await loadFixture(name);
  const fp = await computeFingerprint(ctx.worktree);
  const sessDir = sessionDir(fp.fingerprint, ctx.sessionID);
  await fs.mkdir(sessDir, { recursive: true });
  await fs.writeFile(statePath(sessDir), `${JSON.stringify(fixture, null, 2)}\n`, 'utf-8');
  return sessDir;
}

describe('session-state upgrade compatibility', () => {
  beforeEach(async () => {
    ws = await createTestWorkspace();
    ctx = createToolContext({
      worktree: ws.tmpDir,
      directory: ws.tmpDir,
      sessionID: crypto.randomUUID(),
    });
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await ws.cleanup();
  });

  it('status works on old states (read-only compatibility)', async () => {
    const fixtures = [
      'v1-no-identity-provider-mode.json',
      'v1-no-minimum-actor-assurance.json',
      'v1-no-external-references.json',
      'v1-no-archive-status.json',
      'v1-legacy-policy-snapshot.json',
    ];

    for (const file of fixtures) {
      await writeFixtureState(file);
      const result = parseToolResult(await status.execute({}, ctx));
      expect(result.phase).toBeTruthy();
      expect(result.error).not.toBe(true);
    }
  });

  it('legacy snapshot resolves with safe defaults (no unsafe uplift)', async () => {
    const fixture = await loadFixture('v1-legacy-policy-snapshot.json');
    const snapshot = fixture.policySnapshot as Record<string, unknown>;
    const policy = resolvePolicyFromSnapshot(snapshot as never);

    expect(policy.identityProviderMode).toBe('optional');
    expect(policy.minimumActorAssuranceForApproval).toBe('claim_validated');
  });

  it('mutating decision path remains fail-closed for legacy regulated snapshots', async () => {
    const sessDir = await writeFixtureState('v1-legacy-policy-snapshot.json');
    const state = await readState(sessDir);
    expect(state).not.toBeNull();

    const policy = resolvePolicyFromSnapshot(state!.policySnapshot);
    const result = executeReviewDecision(
      state!,
      {
        verdict: 'approve',
        rationale: 'legacy approval attempt',
        decidedBy: 'legacy-reviewer',
        decisionIdentity: {
          actorId: 'legacy-reviewer',
          actorEmail: 'legacy-reviewer@example.com',
          actorSource: 'env',
          actorAssurance: 'best_effort',
        },
      },
      {
        now: () => '2026-04-29T00:00:00.000Z',
        digest: (text) => text,
        policy,
      },
    );

    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') {
      expect(result.code).toBe('ACTOR_ASSURANCE_INSUFFICIENT');
    }
  });

  it('external references remain optional for legacy ticket evidence', async () => {
    const sessDir = await writeFixtureState('v1-no-external-references.json');
    const state = await readState(sessDir);
    expect(state).not.toBeNull();
    expect(state!.ticket).not.toBeNull();
    expect(state!.ticket!.references).toBeUndefined();

    const result = parseToolResult(await status.execute({ evidence: true }, ctx));
    expect(result.phase).toBe('TICKET');
    expect(result.error).not.toBe(true);
  });

  it('missing archiveStatus in legacy state is surfaced as null in status', async () => {
    await writeFixtureState('v1-no-archive-status.json');
    const result = parseToolResult(await status.execute({}, ctx));
    expect(result.phase).toBe('COMPLETE');
    expect(result.archiveStatus).toBeNull();
  });
});
