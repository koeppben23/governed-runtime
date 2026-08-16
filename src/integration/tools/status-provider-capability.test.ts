import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as crypto from 'node:crypto';
import { status, hydrate } from './index.js';
import {
  createToolContext,
  createTestWorkspace,
  parseToolResult,
  type TestToolContext,
  type TestWorkspace,
  withTestEnv,
} from '../test-helpers.js';
import { readState, writeState } from '../../adapters/persistence.js';

let ctx: TestToolContext;
let ws: TestWorkspace;

beforeEach(async () => {
  ws = await createTestWorkspace();
  ctx = createToolContext({
    worktree: ws.tmpDir,
    directory: ws.tmpDir,
    sessionID: `ses_${crypto.randomUUID().replace(/-/g, '')}`,
  });
});

afterEach(async () => {
  await ws.cleanup();
});

describe('flowguard_status providerCapabilities', () => {
  it('surfaces detected vitest with binding and candidate available', async () => {
    await hydrate.execute({ policyMode: 'solo' }, ctx);
    const { computeFingerprint, sessionDir: resolveSessionDir } =
      await import('../../adapters/workspace/index.js');
    const fp = await computeFingerprint(ws.tmpDir);
    const sessDir = resolveSessionDir(fp.fingerprint, ctx.sessionID);
    const state = await readState(sessDir);
    if (!state) throw new Error('No session state after hydration');

    await writeState(sessDir, {
      ...state,
      detectedStack: {
        summary: '',
        items: [{ kind: 'testFramework', id: 'vitest', evidence: 'vitest.config.ts' }],
        versions: [],
      },
      verificationCandidates: [
        {
          assertionCapability: 'structured' as const,
          kind: 'test',
          command: 'npx vitest run',
          source: 'detectedStack:testFramework:vitest',
          confidence: 'medium' as const,
          reason: 'test',
          assertionReport: {
            collection: 'run_specific' as const,
            transport: 'file' as const,
            format: 'vitest_json' as const,
            providerId: 'vitest' as const,
            outputArgumentTemplate: '--out={attemptId}',
            resultPatternTemplate: '{attemptId}.json',
          },
        },
      ],
    });

    const result = parseToolResult(await status.execute({}, ctx));
    const caps = result.providerCapabilities as Array<Record<string, unknown>>;
    expect(caps).toHaveLength(5);

    const v = caps.find((c) => c.providerId === 'vitest')!;
    expect((v.detection as Record<string, unknown>).status).toBe('detected');
    expect((v.assertionBinding as Record<string, unknown>).status).toBe('available');
    expect((v.candidate as Record<string, unknown>).status).toBe('available');

    const g = caps.find((c) => c.providerId === 'go_test')!;
    expect((g.detection as Record<string, unknown>).status).toBe('not_detected');
  });
});
