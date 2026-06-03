/**
 * @module integration/tools/hydrate-rmw-locking.test
 * @description Concurrency regression for the hydrate read-modify-write window (#429).
 *
 * Defect: runHydrate read session state OUTSIDE the session write lock, then
 * performed discovery / actor resolution / reconcile, and only acquired the
 * lock at write time. A concurrent mutable transaction (e.g. ticket submit)
 * that committed between hydrate's stale read and hydrate's write was silently
 * lost — hydrate clobbered it with state derived from the stale snapshot.
 *
 * This test pins the lost-update behavior:
 *   - BEFORE fix: the concurrent ticket write is lost (RED).
 *   - AFTER fix:  the full hydrate RMW runs under one session write lock, the
 *     concurrent ticket serializes against it, and both effects survive (GREEN).
 *
 * The delay seam is injected via resolveActor, which hydrate awaits AFTER its
 * (previously unlocked) state read and BEFORE its write. With the fix, that
 * await happens while the lock is held, so the concurrent ticket must wait.
 *
 * @version v1
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'node:crypto';

import {
  createToolContext,
  createTestWorkspace,
  GIT_MOCK_DEFAULTS,
  type TestToolContext,
  type TestWorkspace,
} from '../test-helpers.js';
import { hydrate, ticket } from './index.js';
import { readState } from '../../adapters/persistence.js';
import {
  computeFingerprint,
  sessionDir as resolveSessionDir,
} from '../../adapters/workspace/index.js';

// ─── Mocks (mirror e2e-workflow harness) ──────────────────────────────────────

vi.mock('../../adapters/git', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/git.js')>();
  return {
    ...original,
    remoteOriginUrl: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.remoteOriginUrl),
    changedFiles: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.changedFiles),
    listRepoSignals: vi.fn().mockResolvedValue(GIT_MOCK_DEFAULTS.repoSignals),
  };
});

vi.mock('../../adapters/actor', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/actor.js')>();
  return {
    ...original,
    resolveActor: vi.fn().mockResolvedValue({
      id: 'test-operator',
      email: 'test@flowguard.dev',
      displayName: null,
      source: 'env' as const,
      assurance: 'best_effort' as const,
    }),
  };
});

const actorMock = await import('../../adapters/actor.js');

const DEFAULT_ACTOR = {
  id: 'test-operator',
  email: 'test@flowguard.dev',
  displayName: null,
  source: 'env' as const,
  assurance: 'best_effort' as const,
};

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
  vi.mocked(actorMock.resolveActor).mockReset().mockResolvedValue(DEFAULT_ACTOR);
  vi.clearAllMocks();
  await ws.cleanup();
});

async function getSessDir(): Promise<string> {
  const fp = await computeFingerprint(ctx.worktree);
  return resolveSessionDir(fp.fingerprint, ctx.sessionID);
}

describe('hydrate — read-modify-write locking (#429)', () => {
  it('does not lose a concurrent ticket write committed during hydrate', async () => {
    // 1. Bootstrap an existing session (phase READY, ticket=null).
    const h1 = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, ctx);
    expect(JSON.parse((h1 as unknown as string).split('\n')[0]!).phase).toBe('READY');

    const sessDir = await getSessDir();
    const before = await readState(sessDir);
    expect(before).not.toBeNull();
    expect(before!.ticket).toBeNull();

    // 2. Arm a one-shot delay in resolveActor for the NEXT hydrate call only.
    //    hydrate awaits resolveActor AFTER reading state and BEFORE writing, so
    //    the concurrent ticket can commit inside this window.
    vi.mocked(actorMock.resolveActor).mockImplementationOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return DEFAULT_ACTOR;
    });

    // 3. Run a re-hydrate concurrently with a ticket submit.
    //    The ticket transaction is fully serialized under the session write lock;
    //    hydrate must not clobber its committed result with the stale snapshot.
    await Promise.all([
      hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, ctx),
      (async () => {
        // Let hydrate take its stale read first, then commit the ticket.
        await new Promise((resolve) => setTimeout(resolve, 5));
        await ticket.execute({ text: 'My task', source: 'user' }, ctx);
      })(),
    ]);

    // 4. The ticket write MUST survive. Pre-fix, hydrate's stale-derived write
    //    overwrites it (ticket back to null) → lost update.
    const after = await readState(sessDir);
    expect(after).not.toBeNull();
    expect(after!.ticket).not.toBeNull();
    expect(after!.ticket!.text).toBe('My task');
  });
});
