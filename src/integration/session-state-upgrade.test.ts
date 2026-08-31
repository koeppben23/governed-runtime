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
  const file = path.join(process.cwd(), 'src', 'fixtures', 'session-state', name);
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

describe('session-state current epoch boundary', () => {
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

  it('rejects legacy snapshots without a versioned digest', async () => {
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
      expect(result.error).toBe(true);
      expect(result.code).toBe('SESSION_STATE_INCOMPATIBLE');
    }
  });

  it('rejects legacy regulated snapshots before a decision can execute', async () => {
    const sessDir = await writeFixtureState('v1-legacy-policy-snapshot.json');
    await expect(readState(sessDir)).rejects.toMatchObject({
      code: 'SESSION_STATE_INCOMPATIBLE',
    });
  });

  it('rejects legacy ticket evidence with an unversioned digest', async () => {
    const sessDir = await writeFixtureState('v1-no-external-references.json');
    await expect(readState(sessDir)).rejects.toMatchObject({
      code: 'SESSION_STATE_INCOMPATIBLE',
    });
  });

  it('rejects legacy states with missing archive status and unversioned digests', async () => {
    await writeFixtureState('v1-no-archive-status.json');
    const result = parseToolResult(await status.execute({}, ctx));
    expect(result.error).toBe(true);
    expect(result.code).toBe('SESSION_STATE_INCOMPATIBLE');
  });
});
