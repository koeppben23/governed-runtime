/**
 * @module documentation/demo-review-navigation-benchmark
 * @description The DREP A/B reader verifies the prompt variant from the real
 * child transcript, attributes attempt-bound metrics, and reports missing data
 * as NOT_VERIFIED instead of zero seconds.
 */

import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  analyzeRoot,
  runAnalysis,
  summarize,
} from '../../../demos/lib/review-navigation-benchmark.mjs';

const roots: string[] = [];
const NOW = '2026-10-18T00:00:00.000Z';

async function rootFixture(input: {
  variant: 'on' | 'off';
  pairId?: string;
  withInstruction?: boolean;
  valid?: boolean;
  missingState?: boolean;
}): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'drep-ab-'));
  roots.push(root);
  await fs.mkdir(path.join(root, 'evidence'), { recursive: true });
  await fs.mkdir(path.join(root, 'config', 'workspaces', 'fp', 'sessions', 'ses_parent'), {
    recursive: true,
  });
  const instruction = input.withInstruction ?? input.variant === 'on';
  const prompt = [
    '## Instructions',
    ...(instruction ? ['### Review Navigation (host instruction)'] : []),
    ...(input.variant === 'on' && instruction
      ? ['{"version":"review-navigation.v1","requirements":[]}']
      : []),
    'raw material',
  ].join('\n');
  await fs.writeFile(
    path.join(root, 'evidence', 'metadata.json'),
    JSON.stringify({
      model: 'test/model',
      harnessVersion: 'demo-harness.v6',
      tarballSha256: 'tarball-sha',
      reviewNavigation: input.variant,
      pairId: input.pairId ?? null,
    }),
  );
  await fs.writeFile(
    path.join(root, 'evidence', 'flows.json'),
    JSON.stringify([
      {
        name: 'development',
        hostSessionId: 'ses_parent',
        transcripts: {
          reviewers: [{ sessionId: 'ses_child', file: 'development-host-ses_child.json' }],
        },
      },
    ]),
  );
  await fs.writeFile(
    path.join(root, 'evidence', 'development-host-ses_child.json'),
    JSON.stringify({
      messages: [
        {
          info: { role: 'user', time: { created: 1000 } },
          parts: [{ type: 'text', text: prompt }],
        },
        {
          info: {
            role: 'assistant',
            time: { created: 1001, completed: input.valid === false ? 2000 : 4000 },
            tokens: { total: 120 },
            cost: 0.01,
          },
          parts: [{ type: 'tool', tool: 'flowguard_observe_repository' }],
        },
      ],
    }),
  );
  if (!input.missingState) {
    await fs.writeFile(
      path.join(root, 'config', 'workspaces', 'fp', 'sessions', 'ses_parent', 'session-state.json'),
      JSON.stringify({
        reviewAssurance: {
          obligations: [{ obligationId: 'ob-1', status: 'consumed' }],
          attempts: [
            {
              attemptId: 'att-1',
              obligationId: 'ob-1',
              obligationType: 'plan',
              status: input.valid === false ? 'stale' : 'bound',
              origin: { kind: 'initial' },
            },
          ],
          invocations: [
            {
              childSessionId: 'ses_child',
              obligationId: 'ob-1',
              obligationType: 'plan',
              attemptId: 'att-1',
              invokedAt: NOW,
              fulfilledAt: new Date(Date.parse(NOW) + 2500).toISOString(),
              capturedVerdict: input.valid === false ? 'unable_to_review' : 'accept',
            },
          ],
        },
      }),
    );
  }
  return root;
}

afterEach(async () => {
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true });
});

describe('review-navigation A/B benchmark', () => {
  it('verifies the variant from the child prompt and attributes valid-review time', async () => {
    const root = await rootFixture({ variant: 'on', pairId: 'p1' });
    const analyzed = analyzeRoot(root);
    expect(analyzed.variant).toBe('on');
    expect(analyzed.entries).toHaveLength(1);
    expect(analyzed.entries[0]).toMatchObject({
      type: 'plan',
      valid: true,
      validMs: 2500,
      variantApplied: true,
      indexPresent: true,
      steps: 1,
      observations: 1,
      tokens: 120,
      rearmCount: 0,
    });
  });

  it('reports an off prompt without the instruction as applied and valid', async () => {
    const root = await rootFixture({ variant: 'off', pairId: 'p1' });
    const analyzed = analyzeRoot(root);
    expect(analyzed.entries[0]).toMatchObject({
      variantApplied: true,
      indexPresent: false,
      valid: true,
    });
  });

  it('marks a configured variant mismatch NOT_VERIFIED', async () => {
    const root = await rootFixture({ variant: 'on', pairId: 'p1', withInstruction: false });
    const analyzed = analyzeRoot(root);
    expect(analyzed.entries[0]?.variantMismatch).toBe(true);
    const summary = summarize([analyzed]);
    expect(
      summary.summary.find((row) => row.type === 'plan' && row.variant === 'on')?.notVerified,
    ).toBe(true);
  });

  it('keeps invalid reviews out of the valid time while reporting elapsed time', async () => {
    const root = await rootFixture({ variant: 'on', pairId: 'p1', valid: false });
    const analyzed = analyzeRoot(root);
    expect(analyzed.entries[0]).toMatchObject({
      valid: false,
      validMs: null,
      elapsedMs: 1000,
      verdict: 'unable_to_review',
    });
    const summary = summarize([analyzed]);
    const row = summary.summary.find((item) => item.type === 'plan' && item.variant === 'on');
    expect(row?.medianValidMs).toBe('NOT_VERIFIED');
    expect(row?.medianInvalidElapsedMs).toBe(1000);
  });

  it('reports missing state as NOT_VERIFIED instead of fabricating a run', async () => {
    const root = await rootFixture({ variant: 'on', pairId: 'p1', missingState: true });
    const analyzed = analyzeRoot(root);
    expect(analyzed.notVerified).toEqual([
      { flow: 'development', reason: 'session_state_missing' },
    ]);
    const result = runAnalysis({ roots: [root], qualityResult: { passed: true } });
    expect(result.result.qualityGate).toEqual({ passed: true });
    expect(result.markdown).toContain('NOT_VERIFIED');
  });
});
