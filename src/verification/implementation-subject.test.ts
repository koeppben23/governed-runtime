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
