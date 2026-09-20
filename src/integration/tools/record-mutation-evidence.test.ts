/**
 * @module integration/tools/record-mutation-evidence.test
 * @description Contract tests for flowguard_record_mutation_evidence: phase
 *              gating, implementation-digest binding from state, report
 *              loading/validation, append-only attempt persistence and typed
 *              blocked results.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { record_mutation_evidence } from './mutation/record-mutation-evidence.js';
import { MutationAttempt } from '../../state/evidence-mutation.js';
import { resolveWorkspacePaths, writeStateWithArtifacts } from './helpers.js';
import { readState } from '../../adapters/persistence.js';
import { makeProgressedState, makeState } from '../../fixtures.js';
import { parseToolResult } from '../test-helpers.js';

const DEFAULT_REPORT_PATH = 'reports/mutation/mutation.json';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'fg-record-mutation-'));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

function validReport(): string {
  return JSON.stringify({
    schemaVersion: '1.0',
    files: {
      'src/a.ts': {
        mutants: [
          {
            id: '1',
            mutatorName: 'EqualityOperator',
            status: 'Killed',
            location: { start: { line: 1 } },
          },
        ],
      },
    },
  });
}

async function writeReport(
  relativePath: string = DEFAULT_REPORT_PATH,
  content: string = validReport(),
): Promise<void> {
  const full = path.join(tmpDir, relativePath);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, content, 'utf8');
}

async function seedSession(state: unknown): Promise<{
  context: { sessionID: string; worktree: string; directory: string };
  sessDir: string;
}> {
  const sessionID = crypto.randomUUID();
  const context = { sessionID, worktree: tmpDir, directory: tmpDir };
  const { sessDir } = await resolveWorkspacePaths(context);
  await writeStateWithArtifacts(sessDir, state as never);
  return { context, sessDir };
}

function runArgs(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    command: 'npm run mutation',
    startedAt: '2026-09-17T10:00:00.000Z',
    completedAt: '2026-09-17T10:10:00.000Z',
    exitCode: 0,
    reportPath: DEFAULT_REPORT_PATH,
    ...overrides,
  };
}

interface RecordedResult {
  attempt?: {
    attemptId: string;
    implementationDigest: string;
    reportPath: string;
    exitCode: number;
    artifactDigest?: string;
    projectionDigest?: string;
  };
  code?: string;
  message?: string;
  error?: boolean;
}

describe('record_mutation_evidence', () => {
  it('records the attempt bound to the implementation digest from state', async () => {
    const state = makeProgressedState('IMPL_VALIDATION');
    const { context, sessDir } = await seedSession(state);
    await writeReport();

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );

    expect(result.attempt).toBeDefined();
    expect(result.attempt!.implementationDigest).toBe(state.implementation!.digest);
    expect(result.attempt!.reportPath).toBe(DEFAULT_REPORT_PATH);
    expect(result.attempt!.exitCode).toBe(0);
    expect(result.attempt!.artifactDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(result.attempt!.projectionDigest).toMatch(/^[0-9a-f]{64}$/);

    const persisted = await readState(sessDir);
    expect(persisted!.mutationAttempts).toHaveLength(1);
    expect(persisted!.mutationAttempts[0]!.attemptId).toBe(result.attempt!.attemptId);
    expect(persisted!.mutationAttempts[0]!.implementationDigest).toBe(state.implementation!.digest);
  });

  it('applies the default report path when omitted', async () => {
    const { context } = await seedSession(makeProgressedState('IMPL_VALIDATION'));
    await writeReport();
    const { reportPath: _ignored, ...args } = runArgs();

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(args, context as never),
    );

    expect(result.attempt!.reportPath).toBe(DEFAULT_REPORT_PATH);
  });

  it('blocks recording outside the mutation-eligible phases', async () => {
    const { context, sessDir } = await seedSession(makeState('READY'));
    await writeReport();

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );

    expect(result.code).toBe('PROOFGRAPH_MUTATION_PHASE_INELIGIBLE');
    expect(result.message).toContain('READY');
    expect((await readState(sessDir))!.mutationAttempts).toHaveLength(0);
  });

  it('blocks recording without implementation evidence', async () => {
    const { context, sessDir } = await seedSession({
      ...makeProgressedState('IMPL_VALIDATION'),
      implementation: null,
    });
    await writeReport();

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );

    expect(result.code).toBe('PROOFGRAPH_MUTATION_NO_IMPLEMENTATION');
    expect((await readState(sessDir))!.mutationAttempts).toHaveLength(0);
  });

  it('blocks recording when the report file is missing', async () => {
    const { context, sessDir } = await seedSession(makeProgressedState('IMPL_VALIDATION'));

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );

    expect(result.code).toBe('PROOFGRAPH_MUTATION_REPORT_MISSING');
    expect(result.message).toContain(DEFAULT_REPORT_PATH);
    expect((await readState(sessDir))!.mutationAttempts).toHaveLength(0);
  });

  it('blocks recording for an unparsable report', async () => {
    const { context, sessDir } = await seedSession(makeProgressedState('IMPL_VALIDATION'));
    await writeReport(DEFAULT_REPORT_PATH, 'not-json');

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );

    expect(result.code).toBe('PROOFGRAPH_MUTATION_REPORT_INVALID');
    expect(result.message).toContain(DEFAULT_REPORT_PATH);
    expect(result.message).toContain('invalid JSON in mutation report');
    expect((await readState(sessDir))!.mutationAttempts).toHaveLength(0);
  });

  it('appends attempts without rewriting earlier records', async () => {
    const { context, sessDir } = await seedSession(makeProgressedState('IMPL_VALIDATION'));
    await writeReport();

    const first = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );
    const second = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs(), context as never),
    );

    expect(first.attempt!.attemptId).not.toBe(second.attempt!.attemptId);
    const persisted = await readState(sessDir);
    expect(persisted!.mutationAttempts).toHaveLength(2);
    expect(persisted!.mutationAttempts.map((attempt) => attempt.attemptId)).toEqual([
      first.attempt!.attemptId,
      second.attempt!.attemptId,
    ]);
  });

  it('fails closed when the produced attempt violates the schema', async () => {
    const { context, sessDir } = await seedSession(makeProgressedState('IMPL_VALIDATION'));
    await writeReport();
    const parseSpy = vi.spyOn(MutationAttempt, 'parse').mockImplementationOnce(() => {
      throw new Error('schema fail');
    });
    try {
      const result = parseToolResult<RecordedResult>(
        await record_mutation_evidence.execute(runArgs(), context as never),
      );

      expect(result.error).toBe(true);
      expect(result.message).toContain('MutationAttempt failed schema validation');
      expect((await readState(sessDir))!.mutationAttempts).toHaveLength(0);
    } finally {
      parseSpy.mockRestore();
    }
  });

  it('exposes a strict argument contract with the default report path', () => {
    const args = record_mutation_evidence.args as Record<
      string,
      { safeParse: (value: unknown) => { success: boolean }; parse: (value: unknown) => unknown }
    >;

    expect(args['command']!.safeParse('').success).toBe(false);
    expect(args['command']!.safeParse('npm run mutation').success).toBe(true);
    expect(args['startedAt']!.safeParse('not-a-date').success).toBe(false);
    expect(args['exitCode']!.safeParse('0').success).toBe(false);
    expect(args['reportPath']!.parse(undefined)).toBe(DEFAULT_REPORT_PATH);
  });

  it('rejects an empty command through the argument contract', async () => {
    const { context, sessDir } = await seedSession(makeProgressedState('IMPL_VALIDATION'));
    await writeReport();

    const result = parseToolResult<RecordedResult>(
      await record_mutation_evidence.execute(runArgs({ command: '' }), context as never),
    );

    expect(result.error).toBe(true);
    expect((await readState(sessDir))!.mutationAttempts).toHaveLength(0);
  });
});
