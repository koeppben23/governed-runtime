/**
 * @module integration/reduced-ceremony-subject-artifacts-e2e.test
 * @description Real-git regression for the reduced-ceremony subject boundary:
 * FlowGuard's own per-attempt `run_specific` report files must not count as
 * implementation-subject drift.
 *
 *  - the default full-ceremony path (feature disabled) must not gain new
 *    git-derived blocks from the new safety check,
 *  - the reduced path must stay reachable when the legit tool report exists,
 *  - an unexpected additional project file must still fail closed.
 *
 * Only the check executor is mocked (deterministic pass + report write); git,
 * the report artifact, the re-attestation and the ceremony decision are real.
 *
 * @test-policy HAPPY, BAD
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../verification/executor', () => ({
  executeCheck: vi.fn(),
}));

import { readState } from '../adapters/persistence.js';
import { sessionDir } from '../adapters/workspace/index.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { hashText } from '../shared/hashing.js';
import { deriveVerificationCandidateId } from '../state/candidate-identity.js';
import { computeImplementationDigest } from '../verification/implementation-subject.js';
import { executeCheck } from '../verification/executor.js';
import { makeProgressedState, POLICY_SNAPSHOT } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import type { ToolContext } from './tools/helpers.js';
import { hydrate } from './tools/hydrate/hydrate.js';
import { run_check } from './tools/validation/run-check-tool.js';

const DOC_PATH = 'docs/usage-notes.md';
const REPORT_PATH = '.flowguard/reports/{attemptId}/jest.json';

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
    outputArgumentTemplate: `--json --outputFile=${REPORT_PATH}`,
    resultPatternTemplate: REPORT_PATH,
  },
};
const RUN_SPECIFIC_CANDIDATE = {
  ...RUN_SPECIFIC_DEFINITION,
  candidateId: deriveVerificationCandidateId(RUN_SPECIFIC_DEFINITION),
};

interface SE {
  rootDir: string;
  worktree: string;
  sId: string;
  sDir: string;
  tc: ToolContext;
}

let s: SE | undefined;
let pc: string | undefined;

beforeEach(() => {
  pc = process.env.OPENCODE_CONFIG_DIR;
  vi.mocked(executeCheck).mockReset();
});

afterEach(() => {
  if (pc === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = pc;
  if (s) {
    rmSync(s.rootDir, { recursive: true, force: true });
    s = undefined;
  }
});

async function boot(): Promise<SE> {
  const r = mkdtempSync(join(tmpdir(), 'fg-reduced-artifacts-'));
  const w = join(r, 'worktree');
  const c = join(r, 'config');
  const id = randomUUID();
  mkdirSync(w, { recursive: true });
  mkdirSync(c, { recursive: true });
  execFileSync('git', ['init', '-q'], { cwd: w });
  execFileSync('git', ['config', 'user.email', 't@t'], { cwd: w });
  execFileSync('git', ['config', 'user.name', 'T'], { cwd: w });
  writeFileSync(join(w, 'README.md'), '# E2E');
  execFileSync('git', ['add', 'README.md'], { cwd: w });
  execFileSync('git', ['commit', '-q', '-m', 'init'], { cwd: w });
  process.env.OPENCODE_CONFIG_DIR = c;
  const tc: ToolContext = {
    sessionID: id,
    messageID: randomUUID(),
    agent: 'test',
    directory: w,
    worktree: w,
    abort: new AbortController().signal,
    metadata: () => {},
  };
  const hydrated = await hydrate.execute({ policyMode: 'solo', profileId: 'baseline' }, tc);
  if (typeof hydrated !== 'string' || hydrated.includes('"error":true')) {
    throw new Error(`boot hydrate failed: ${String(hydrated).slice(0, 400)}`);
  }
  const fp = await computeFingerprint(w);
  return { rootDir: r, worktree: w, sId: id, sDir: sessionDir(fp.fingerprint, id), tc };
}

/** Executor mock: write the run_specific report the command asks for, pass. */
function executorWritesReport(): void {
  vi.mocked(executeCheck).mockImplementationOnce(async (input) => {
    const reportPath = /--outputFile=(\S+)/.exec(input.command)?.[1];
    if (reportPath === undefined) throw new Error('expected an --outputFile argument');
    const absoluteReportPath = join(input.cwd, reportPath);
    mkdirSync(dirname(absoluteReportPath), { recursive: true });
    writeFileSync(
      absoluteReportPath,
      JSON.stringify({
        testResults: [
          { name: 'tests/a.test.ts', assertionResults: [{ title: 'passes', status: 'passed' }] },
        ],
      }),
    );
    return {
      kind: input.kind,
      command: input.command,
      exitCode: 0,
      passed: true,
      executionMs: 100,
      outputDigest: 'a'.repeat(64),
      stdout: 'OK',
      stderr: '',
      timedOut: false,
      startedAt: '2026-01-01T00:00:00.000Z',
    };
  });
}

/** Real impl subject: the doc file exists in the worktree, digest over it. */
async function subjectState(
  se: SE,
  reduced: boolean,
): Promise<{
  state: SessionState;
  digest: string;
  implementationId: string;
}> {
  mkdirSync(join(se.worktree, 'docs'), { recursive: true });
  writeFileSync(join(se.worktree, DOC_PATH), 'notes\n');
  const implementationId = '00000000-0000-4000-8000-0000000000aa';
  const digest = await computeImplementationDigest({
    worktree: se.worktree,
    files: [DOC_PATH],
    digest: hashText,
  });
  const base = makeProgressedState('IMPL_VALIDATION');
  const state = {
    ...base,
    binding: { ...base.binding, worktree: se.worktree },
    implementationBaseAuthority: undefined,
    claimedTaskClass: 'TRIVIAL' as const,
    implementation: {
      implementationId,
      changedFiles: [DOC_PATH],
      domainFiles: [DOC_PATH],
      digest,
      executedAt: '2026-01-01T00:00:00.000Z',
    },
    implementationRiskAssessment: {
      computedMinimumTaskClass: 'TRIVIAL' as const,
      touchedSurfaces: [DOC_PATH],
      riskTriggers: [],
      assessedFrom: 'implementation_changed_files' as const,
      assessedFileCount: 1,
      implementationDigest: digest,
    },
    activeChecks: ['test'],
    verificationCandidates: [RUN_SPECIFIC_CANDIDATE],
    executionSubjectInputsByCandidateId: {
      [RUN_SPECIFIC_CANDIDATE.candidateId]: [{ kind: 'implementation' as const }],
    },
    policySnapshot: reduced
      ? {
          ...POLICY_SNAPSHOT,
          allowReducedCeremony: true,
          requireHumanGates: true,
          effectiveGateBehavior: 'human_gated' as const,
        }
      : base.policySnapshot,
  };
  await writeStateWithArtifacts(se.sDir, state);
  return { state, digest, implementationId };
}

const RUN = { kind: 'test' as const, candidateId: RUN_SPECIFIC_CANDIDATE.candidateId };

describe('reduced-ceremony subject artifacts (real git)', () => {
  it('HAPPY: a run_specific report never blocks the default full-ceremony advance', async () => {
    s = await boot();
    const se = s;
    await subjectState(se, false);
    executorWritesReport();

    const result = await run_check.execute(RUN, se.tc);

    expect(String(result)).not.toContain('"error":true');
    const state = await readState(se.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
    expect(state!.reducedCeremony).toBeNull();
    // The report really was written into the governed worktree.
    const attempt = state!.validationAttempts.find(
      (entry) => entry.result.candidateId === RUN_SPECIFIC_CANDIDATE.candidateId,
    );
    expect(attempt).toBeDefined();
  });

  it('HAPPY: a legit tool report does not block the reduced-ceremony opt-in', async () => {
    s = await boot();
    const se = s;
    await subjectState(se, true);
    executorWritesReport();

    const result = await run_check.execute(RUN, se.tc);

    expect(String(result)).not.toContain('"error":true');
    const state = await readState(se.sDir);
    expect(state!.reducedCeremony).toMatchObject({
      profile: 'reduced',
      reason: 'POST_IMPL_VERIFIED_TRIVIAL',
    });
    expect(state!.phase).toBe('EVIDENCE_REVIEW');
    expect(state!.implReview).toBeNull();
  });

  it('BAD: an unexpected additional project file still fails the reduced path closed', async () => {
    s = await boot();
    const se = s;
    await subjectState(se, true);
    executorWritesReport();
    writeFileSync(join(se.worktree, 'src-unexpected.ts'), 'export const x = 1;\n');

    const result = await run_check.execute(RUN, se.tc);

    expect(String(result)).toContain('VALIDATION_SUBJECT_CHANGED');
    const state = await readState(se.sDir);
    expect(state!.phase).toBe('IMPL_VALIDATION');
    expect(state!.reducedCeremony).toBeNull();
  });

  it('HAPPY: the disabled feature adds no git-derived block for the same extra file', async () => {
    s = await boot();
    const se = s;
    await subjectState(se, false);
    executorWritesReport();
    writeFileSync(join(se.worktree, 'src-unexpected.ts'), 'export const x = 1;\n');

    const result = await run_check.execute(RUN, se.tc);

    expect(String(result)).not.toContain('"error":true');
    const state = await readState(se.sDir);
    expect(state!.phase).toBe('IMPL_REVIEW');
  });
});
