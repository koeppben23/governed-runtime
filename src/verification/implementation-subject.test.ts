/**
 * @module verification/implementation-subject.test
 * @description Real-git integration contract for governed implementation
 * subject re-attestation: add, delete, rename and modify must all fail closed,
 * and baseline-scoped pre-existing dirt must not.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { hashText } from '../shared/hashing.js';
import { hashWorktreeFiles } from '../adapters/git.js';
import { deriveVerificationCandidateId } from '../state/candidate-identity.js';
import { TEST_EXECUTION_OBSERVATION } from '../state/evidence-test-constants.js';
import { IMPL_EVIDENCE, makeProgressedState, makeState, VALIDATION_PASSED } from '../fixtures.js';
import {
  computeImplementationDigest,
  flowguardReportArtifacts,
  preexistingTargetCheck,
  scopeImplementationFiles,
  reattestImplementationSubject,
} from './implementation-subject.js';

const cleanup: string[] = [];

function git(worktree: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: worktree, encoding: 'utf-8' });
}

function makeRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'impl-subject-'));
  cleanup.push(dir);
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  write(dir, 'README.md', 'base');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'base');
  return dir;
}

function write(worktree: string, path: string, content: string): void {
  mkdirSync(dirname(join(worktree, path)), { recursive: true });
  writeFileSync(join(worktree, path), content);
}

const digestFn = hashText;

async function frozenDigest(worktree: string, files: readonly string[]): Promise<string> {
  return computeImplementationDigest({ worktree, files, digest: digestFn });
}

afterEach(() => {
  for (const dir of cleanup.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const RUN_SPECIFIC_DEFINITION = {
  assertionCapability: 'structured' as const,
  kind: 'test' as const,
  command: 'npm test --',
  source: 'detectedStack:testFramework:jest',
  confidence: 'high' as const,
  reason: 'jest fixture',
  assertionReport: {
    collection: 'run_specific' as const,
    transport: 'file' as const,
    format: 'jest_json' as const,
    providerId: 'jest' as const,
    outputArgumentTemplate: '--json --outputFile=.flowguard/reports/{attemptId}/jest.json',
    resultPatternTemplate: '.flowguard/reports/{attemptId}/jest.json',
  },
};
const RUN_SPECIFIC_CANDIDATE = {
  ...RUN_SPECIFIC_DEFINITION,
  candidateId: deriveVerificationCandidateId(RUN_SPECIFIC_DEFINITION),
};
const RUN_SPECIFIC_ATTEMPT_ID = '00000000-0000-4000-8000-0000000000a1';

function structuredAttempt(
  overrides: {
    attemptId?: string;
    implementationId?: string;
    implementationDigest?: string;
  } = {},
) {
  return {
    attemptId: overrides.attemptId ?? RUN_SPECIFIC_ATTEMPT_ID,
    scope: 'implementation' as const,
    implementationId: overrides.implementationId ?? IMPL_EVIDENCE.implementationId,
    implementationDigest: overrides.implementationDigest ?? IMPL_EVIDENCE.digest,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: {
      ...VALIDATION_PASSED[0]!,
      checkId: 'test',
      candidateId: RUN_SPECIFIC_CANDIDATE.candidateId,
      command: `npm test -- --json --outputFile=.flowguard/reports/${overrides.attemptId ?? RUN_SPECIFIC_ATTEMPT_ID}/jest.json`,
    },
  };
}

/** A still-bound run_specific candidate (id re-derived) with a custom result template. */
function stateWithBoundTemplate(template: string) {
  const definition = {
    ...RUN_SPECIFIC_DEFINITION,
    assertionReport: {
      ...RUN_SPECIFIC_DEFINITION.assertionReport,
      resultPatternTemplate: template,
    },
  };
  const candidate = { ...definition, candidateId: deriveVerificationCandidateId(definition) };
  const attempt = structuredAttempt();
  return makeState('IMPL_VALIDATION', {
    implementation: IMPL_EVIDENCE,
    verificationCandidates: [candidate],
    validationAttempts: [
      { ...attempt, result: { ...attempt.result, candidateId: candidate.candidateId } },
    ],
  });
}

describe('flowguardReportArtifacts', () => {
  it('HAPPY: derives the exact report path of a bound run_specific attempt', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      verificationCandidates: [RUN_SPECIFIC_CANDIDATE],
      validationAttempts: [structuredAttempt()],
    });
    expect(flowguardReportArtifacts(state)).toEqual([
      `.flowguard/reports/${RUN_SPECIFIC_ATTEMPT_ID}/jest.json`,
    ]);
  });

  it('BAD: an edited candidate definition cannot smuggle an exclusion', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      verificationCandidates: [
        {
          ...RUN_SPECIFIC_CANDIDATE,
          assertionReport: {
            ...RUN_SPECIFIC_DEFINITION.assertionReport,
            resultPatternTemplate: 'src/anything.ts',
          },
        },
      ],
      validationAttempts: [structuredAttempt()],
    });
    expect(flowguardReportArtifacts(state)).toEqual([]);
  });

  it.each([
    ['an embedded traversal', '.flowguard/../../outside/{attemptId}.json'],
    ['a leading traversal', '../outside/{attemptId}.json'],
    ['a Windows-separated traversal', 'reports\\..\\..\\outside.json'],
    ['an absolute path', '/etc/{attemptId}.json'],
  ])('BAD: a bound template with %s contributes no artifact path', (_label, template) => {
    expect(flowguardReportArtifacts(stateWithBoundTemplate(template))).toEqual([]);
  });

  it('CORNER: an in-worktree template with a redundant segment is collapsed', () => {
    expect(
      flowguardReportArtifacts(
        stateWithBoundTemplate('.flowguard/tmp/../reports/{attemptId}/jest.json'),
      ),
    ).toEqual([`.flowguard/reports/${RUN_SPECIFIC_ATTEMPT_ID}/jest.json`]);
  });

  it('HAPPY: baseline attempts of the current plan contribute their report paths', () => {
    const base = makeProgressedState('VALIDATION');
    const state = makeState('VALIDATION', {
      plan: base.plan,
      verificationCandidates: [RUN_SPECIFIC_CANDIDATE],
      validationAttempts: [
        {
          attemptId: RUN_SPECIFIC_ATTEMPT_ID,
          scope: 'baseline' as const,
          planDigest: base.plan!.current.digest,
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: { ...structuredAttempt().result },
        },
      ],
    });
    expect(flowguardReportArtifacts(state)).toEqual([
      `.flowguard/reports/${RUN_SPECIFIC_ATTEMPT_ID}/jest.json`,
    ]);
  });

  it('BAD: baseline attempts of an earlier plan version stay visible', () => {
    const base = makeProgressedState('VALIDATION');
    const state = makeState('VALIDATION', {
      plan: base.plan,
      verificationCandidates: [RUN_SPECIFIC_CANDIDATE],
      validationAttempts: [
        {
          attemptId: RUN_SPECIFIC_ATTEMPT_ID,
          scope: 'baseline' as const,
          planDigest: 'superseded-plan-digest',
          executionObservation: TEST_EXECUTION_OBSERVATION,
          result: { ...structuredAttempt().result },
        },
      ],
    });
    expect(flowguardReportArtifacts(state)).toEqual([]);
  });

  it('HAPPY: superseded implementation generations still contribute (freeze/reattest symmetry)', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      verificationCandidates: [RUN_SPECIFIC_CANDIDATE],
      validationAttempts: [
        structuredAttempt({ implementationId: '00000000-0000-4000-8000-0000000000bb' }),
        structuredAttempt({ implementationDigest: 'other-digest' }),
      ],
    });
    expect(flowguardReportArtifacts(state)).toEqual([
      `.flowguard/reports/${RUN_SPECIFIC_ATTEMPT_ID}/jest.json`,
    ]);
  });

  it('CORNER: non-run_specific candidates contribute no artifact paths', () => {
    const state = makeState('IMPL_VALIDATION', {
      implementation: IMPL_EVIDENCE,
      verificationCandidates: [
        {
          assertionCapability: 'unsupported' as const,
          candidateId: 'vc_plain',
          kind: 'test' as const,
          command: 'npm test',
          source: 'x',
          confidence: 'high' as const,
          reason: 'x',
        },
      ],
      validationAttempts: [
        {
          ...structuredAttempt(),
          result: { ...structuredAttempt().result, candidateId: 'vc_plain' },
        },
      ],
    });
    expect(flowguardReportArtifacts(state)).toEqual([]);
  });
});

describe('preexistingTargetCheck', () => {
  const baseline = (dirtyFiles: Array<{ path: string; hash: string | null }> | null) => ({
    dirtyFiles,
    capturedAt: new Date().toISOString(),
    controlPlaneMarker: 'marker',
  });

  it('blocks baseline-dirty target paths even when they are currently clean', async () => {
    const dir = makeRepo();
    const result = await preexistingTargetCheck({
      worktree: dir,
      baseline: baseline([{ path: 'target.txt', hash: 'old-hash' }]),
      targetPaths: ['target.txt'],
    });
    expect(result).toEqual({
      kind: 'dirty',
      baselinePaths: ['target.txt'],
      currentPaths: [],
    });
  });

  it('blocks a target that is dirty now even if it was clean at session start', async () => {
    const dir = makeRepo();
    write(dir, 'target.txt', 'changed');
    const result = await preexistingTargetCheck({
      worktree: dir,
      baseline: baseline([]),
      targetPaths: ['target.txt'],
    });
    expect(result).toEqual({
      kind: 'dirty',
      baselinePaths: [],
      currentPaths: ['target.txt'],
    });
  });

  it('allows a clean target that was not dirty at session start', async () => {
    const dir = makeRepo();
    const result = await preexistingTargetCheck({
      worktree: dir,
      baseline: baseline([]),
      targetPaths: ['target.txt'],
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('fails closed when the baseline capture is unavailable and targets exist', async () => {
    const dir = makeRepo();
    const result = await preexistingTargetCheck({
      worktree: dir,
      baseline: baseline(null),
      targetPaths: ['target.txt'],
    });
    expect(result).toEqual({ kind: 'unavailable' });
  });

  it('normalizes repository-relative target paths', async () => {
    const dir = makeRepo();
    const result = await preexistingTargetCheck({
      worktree: dir,
      baseline: baseline([{ path: './target.txt', hash: 'old-hash' }]),
      targetPaths: ['target.txt'],
    });
    expect(result).toMatchObject({ kind: 'dirty', baselinePaths: ['target.txt'] });
  });

  it.each(['././target.txt', 'src/../target.txt', '.\\.\\target.txt', 'target.txt/'])(
    'does not let alias %s bypass baseline dirt',
    async (path) => {
      expect(
        await preexistingTargetCheck({
          worktree: makeRepo(),
          baseline: baseline([{ path: 'target.txt', hash: 'old' }]),
          targetPaths: [path],
        }),
      ).toMatchObject({ kind: 'dirty', baselinePaths: ['target.txt'] });
    },
  );

  it.each([
    '/target.txt',
    '../target.txt',
    'src/../../target.txt',
    'C:\\target.txt',
    '',
    '.',
    'a\0b',
  ])('rejects invalid target %s', async (path) => {
    expect(
      await preexistingTargetCheck({
        worktree: makeRepo(),
        baseline: baseline([]),
        targetPaths: [path],
      }),
    ).toEqual({ kind: 'invalid', path });
  });

  it('does not bypass a missing capture by omitting targets', async () => {
    expect(
      await preexistingTargetCheck({
        worktree: makeRepo(),
        baseline: baseline(null),
        targetPaths: [],
      }),
    ).toEqual({ kind: 'unavailable' });
  });

  it('blocks unknown scope with baseline or current dirt but permits a clean scope', async () => {
    const worktree = makeRepo();
    expect(
      await preexistingTargetCheck({ worktree, baseline: baseline([]), targetPaths: [] }),
    ).toEqual({ kind: 'ok' });
    expect(
      await preexistingTargetCheck({
        worktree,
        baseline: baseline([{ path: 'old', hash: 'old' }]),
        targetPaths: [],
      }),
    ).toMatchObject({ kind: 'dirty', baselinePaths: ['old'] });
    write(worktree, 'new', 'dirt');
    expect(
      await preexistingTargetCheck({ worktree, baseline: baseline([]), targetPaths: [] }),
    ).toMatchObject({ kind: 'dirty', currentPaths: ['new'] });
  });

  it('does not block unrelated dirt when targets are explicitly bounded', async () => {
    const worktree = makeRepo();
    write(worktree, 'unrelated.txt', 'unrelated');
    expect(
      await preexistingTargetCheck({
        worktree,
        baseline: baseline([{ path: 'unrelated.txt', hash: 'old' }]),
        targetPaths: ['target.txt'],
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('never attributes the whole worktree when the capture is unavailable, even if empty', async () => {
    const worktree = makeRepo();
    for (const files of [[], ['target.txt']]) {
      expect(await scopeImplementationFiles(worktree, files, baseline(null))).toEqual({
        kind: 'unavailable',
      });
    }
    expect(
      await reattestImplementationSubject({
        worktree,
        frozenFiles: [],
        expectedDigest: 'frozen',
        baseline: baseline(null),
        digest: digestFn,
      }),
    ).toEqual({ kind: 'subject_changed', expected: 'frozen', actual: 'baseline-unavailable' });
  });

  it('fails closed on a schema-readable but invalid captured baseline path', async () => {
    const worktree = makeRepo();
    const invalid = baseline([{ path: '../outside', hash: 'old' }]);
    expect(
      await preexistingTargetCheck({ worktree, baseline: invalid, targetPaths: ['target.txt'] }),
    ).toEqual({ kind: 'unavailable' });
    expect(await scopeImplementationFiles(worktree, ['target.txt'], invalid)).toEqual({
      kind: 'unavailable',
    });
  });

  it('fails closed when any raw implementation path is invalid, even in a mixed set', async () => {
    expect(
      await scopeImplementationFiles(makeRepo(), ['target.txt', '../outside'], baseline([])),
    ).toEqual({ kind: 'unavailable' });
  });

  it('keeps baseline files when either the before or current hash is unavailable', async () => {
    const worktree = makeRepo();
    write(worktree, 'target.txt', 'current bytes');
    expect(
      await scopeImplementationFiles(
        worktree,
        ['target.txt'],
        baseline([{ path: 'target.txt', hash: null }]),
      ),
    ).toMatchObject({ kind: 'ok', subject: { files: ['target.txt'] } });
    expect(
      await scopeImplementationFiles(
        worktree,
        ['deleted.txt'],
        baseline([{ path: 'deleted.txt', hash: 'old' }]),
      ),
    ).toMatchObject({ kind: 'ok', subject: { files: ['deleted.txt'] } });
  });
});

describe('reattestImplementationSubject', () => {
  it('HAPPY: proves the frozen doc-only subject while the worktree is unchanged', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
    });

    expect(result).toEqual({ kind: 'ok', digest });
  });

  it('BAD: a file added after the freeze fails closed (not in the stored list)', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    write(worktree, 'src/security/policy.ts', 'export const policy = 1;');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('BAD: a modified frozen file fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    write(worktree, 'docs/usage-notes.md', 'notes changed');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('BAD: a deleted frozen file fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    unlinkSync(join(worktree, 'docs/usage-notes.md'));

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('BAD: a rename fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    git(worktree, 'add', 'docs/usage-notes.md');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    git(worktree, 'mv', 'docs/usage-notes.md', 'docs/notes-renamed.md');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('CORNER: unchanged pre-existing dirt is scoped out by the frozen baseline', async () => {
    const worktree = makeRepo();
    write(worktree, 'package.json', '{"version":"dirty"}');
    const dirtyHash = (await hashWorktreeFiles(worktree, ['package.json']))['package.json']!;
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: {
        dirtyFiles: [{ path: 'package.json', hash: dirtyHash }],
        capturedAt: '2026-01-01T00:00:00.000Z',
        controlPlaneMarker: 'marker-1',
      },
      digest: digestFn,
    });

    expect(result).toEqual({ kind: 'ok', digest });
  });

  it('HAPPY: a declared FlowGuard report artifact is not subject drift', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);
    const artifact = '.flowguard/reports/attempt-1/jest.json';
    write(worktree, artifact, '{"testResults":[]}');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
      ignoredArtifacts: [artifact],
    });

    expect(result).toEqual({ kind: 'ok', digest });
  });

  it('BAD: an undeclared new file still fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);
    write(worktree, '.flowguard/reports/attempt-1/jest.json', '{"testResults":[]}');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: makeState().implementationBaseline,
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });

  it('EDGE: pre-existing dirt modified since the baseline is kept and fails closed', async () => {
    const worktree = makeRepo();
    write(worktree, 'package.json', '{"version":"dirty"}');
    const dirtyHash = (await hashWorktreeFiles(worktree, ['package.json']))['package.json']!;
    write(worktree, 'docs/usage-notes.md', 'notes');
    const frozen = ['docs/usage-notes.md'];
    const digest = await frozenDigest(worktree, frozen);

    write(worktree, 'package.json', '{"version":"changed after freeze"}');

    const result = await reattestImplementationSubject({
      worktree,
      frozenFiles: frozen,
      expectedDigest: digest,
      baseline: {
        dirtyFiles: [{ path: 'package.json', hash: dirtyHash }],
        capturedAt: '2026-01-01T00:00:00.000Z',
        controlPlaneMarker: 'marker-1',
      },
      digest: digestFn,
    });

    expect(result.kind).toBe('subject_changed');
  });
});
