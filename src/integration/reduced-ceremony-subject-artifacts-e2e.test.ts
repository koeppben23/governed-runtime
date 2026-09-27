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
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../verification/executor', () => ({
  executeCheck: vi.fn(),
}));

import { readState } from '../adapters/persistence.js';
import { sessionDir, verifyArchive } from '../adapters/workspace/index.js';
import { computeFingerprint } from '../adapters/workspace/fingerprint.js';
import { hashText } from '../shared/hashing.js';
import { evaluateCompleteness } from '../audit/completeness.js';
import { deriveVerificationCandidateId } from '../state/candidate-identity.js';
import { computeImplementationDigest } from '../verification/implementation-subject.js';
import { executeCheck } from '../verification/executor.js';
import { makeProgressedState, POLICY_SNAPSHOT } from '../fixtures.js';
import type { SessionState } from '../state/schema.js';
import { writeStateWithArtifacts } from './tools/helpers.js';
import type { ToolContext } from './tools/helpers.js';
import { decision, export as exportTool } from './tools/index.js';
import { reconcilePendingAuditOperations } from './plugin-audit.js';
import { createSessionCompletionAuditDeps } from './services/regulated-completion.js';
import { hydrate } from './tools/hydrate/hydrate.js';
import { implement } from './tools/implementation/implement.js';
import { run_check } from './tools/validation/run-check-tool.js';
import { clearUserDecisionIntents, recordUserDecisionIntent } from './user-decision-intent.js';

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
  configDir: string;
  fingerprint: string;
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
  clearUserDecisionIntents();
  if (pc === undefined) delete process.env.OPENCODE_CONFIG_DIR;
  else process.env.OPENCODE_CONFIG_DIR = pc;
  if (s) {
    rmSync(s.rootDir, { recursive: true, force: true });
    s = undefined;
  }
});

interface BootOptions {
  readonly policyMode?: 'solo' | 'team';
  readonly claimedTaskClass?: 'TRIVIAL';
  readonly allowReducedCeremony?: boolean;
}

async function boot(options: BootOptions = {}): Promise<SE> {
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
  if (options.allowReducedCeremony !== undefined) {
    // Global config keeps the worktree clean (no untracked config artifact).
    writeFileSync(
      join(c, 'flowguard.json'),
      JSON.stringify({
        schemaVersion: 'v1',
        policy: { defaultMode: 'team', allowReducedCeremony: options.allowReducedCeremony },
      }),
    );
  }
  const tc: ToolContext = {
    sessionID: id,
    messageID: randomUUID(),
    agent: 'test',
    directory: w,
    worktree: w,
    abort: new AbortController().signal,
    metadata: () => {},
  };
  const hydrated = await hydrate.execute(
    {
      policyMode: options.policyMode ?? 'solo',
      profileId: 'baseline',
      ...(options.claimedTaskClass !== undefined
        ? { claimedTaskClass: options.claimedTaskClass }
        : {}),
    },
    tc,
  );
  if (typeof hydrated !== 'string' || hydrated.includes('"error":true')) {
    throw new Error(`boot hydrate failed: ${String(hydrated).slice(0, 400)}`);
  }
  const fp = await computeFingerprint(w);
  return {
    rootDir: r,
    worktree: w,
    configDir: c,
    fingerprint: fp.fingerprint,
    sId: id,
    sDir: sessionDir(fp.fingerprint, id),
    tc,
  };
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
      startedAt: '2026-09-01T00:00:00.000Z',
    };
  });
}

/** Real impl subject: the doc file exists in the worktree, digest over it. */
async function subjectState(
  se: SE,
  reduced: boolean,
  policySnapshot?: SessionState['policySnapshot'],
  identityBase?: SessionState,
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
    ...(identityBase !== undefined
      ? {
          id: identityBase.id,
          flowguardSessionId: identityBase.flowguardSessionId,
          binding: identityBase.binding,
          createdAt: identityBase.createdAt,
          initiatedBy: identityBase.initiatedBy,
          initiatedByIdentity: identityBase.initiatedByIdentity,
        }
      : { binding: { ...base.binding, worktree: se.worktree } }),
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
    policySnapshot:
      policySnapshot ??
      (reduced
        ? {
            ...POLICY_SNAPSHOT,
            allowReducedCeremony: true,
            requireHumanGates: true,
            effectiveGateBehavior: 'human_gated' as const,
          }
        : base.policySnapshot),
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

describe('baseline VALIDATION reports (real git)', () => {
  /** Drive VALIDATION with a real baseline run_specific check. */
  async function baselineReportRun(se: SE): Promise<string> {
    const base = makeProgressedState('VALIDATION');
    await writeStateWithArtifacts(se.sDir, {
      ...base,
      binding: { ...base.binding, worktree: se.worktree },
      implementationBaseAuthority: undefined,
      activeChecks: ['test'],
      verificationCandidates: [RUN_SPECIFIC_CANDIDATE],
      executionSubjectInputsByCandidateId: {
        [RUN_SPECIFIC_CANDIDATE.candidateId]: [{ kind: 'implementation' as const }],
      },
    });
    executorWritesReport();
    const result = await run_check.execute(RUN, se.tc);
    if (String(result).includes('"error":true')) {
      throw new Error(`baseline check failed: ${String(result).slice(0, 400)}`);
    }
    const state = await readState(se.sDir);
    if (state!.phase !== 'IMPLEMENTATION') {
      throw new Error(`baseline check did not advance: ${state!.phase}`);
    }
    const attempt = state!.validationAttempts.find((entry) => entry.scope === 'baseline');
    if (attempt === undefined) throw new Error('no baseline attempt recorded');
    return `.flowguard/reports/${attempt.attemptId}/jest.json`;
  }

  async function optIn(se: SE): Promise<void> {
    const state = await readState(se.sDir);
    await writeStateWithArtifacts(se.sDir, {
      ...state!,
      claimedTaskClass: 'TRIVIAL',
      policySnapshot: {
        ...POLICY_SNAPSHOT,
        allowReducedCeremony: true,
        requireHumanGates: true,
        effectiveGateBehavior: 'human_gated',
      },
    });
  }

  it('HAPPY: VALIDATION report → /implement → IMPL_VALIDATION → reduced decision', async () => {
    s = await boot();
    const se = s;
    const reportPath = await baselineReportRun(se);
    expect(existsSync(join(se.worktree, reportPath))).toBe(true);
    await optIn(se);

    // The doc-only delivery; the baseline report is untracked in the worktree.
    mkdirSync(join(se.worktree, 'docs'), { recursive: true });
    writeFileSync(join(se.worktree, DOC_PATH), 'notes\n');
    executorWritesReport();
    const result = await implement.execute({}, se.tc);

    expect(String(result)).not.toContain('INTERNAL_ERROR');
    const state = await readState(se.sDir);
    expect(state!.implementation?.changedFiles).toEqual([DOC_PATH]);
    expect(state!.implementationRiskAssessment?.computedMinimumTaskClass).toBe('TRIVIAL');
    expect(state!.reducedCeremony).toMatchObject({
      profile: 'reduced',
      reason: 'POST_IMPL_VERIFIED_TRIVIAL',
    });
    expect(state!.phase).toBe('EVIDENCE_REVIEW');
  });

  it('BAD: an unexpected project file stays in the governed set and denies reduction', async () => {
    s = await boot();
    const se = s;
    await baselineReportRun(se);
    await optIn(se);

    mkdirSync(join(se.worktree, 'docs'), { recursive: true });
    writeFileSync(join(se.worktree, DOC_PATH), 'notes\n');
    writeFileSync(join(se.worktree, 'src-unexpected.ts'), 'export const x = 1;\n');
    executorWritesReport();
    const result = await implement.execute({}, se.tc);

    expect(String(result)).not.toContain('INTERNAL_ERROR');
    const state = await readState(se.sDir);
    expect(state!.implementation?.changedFiles).toEqual([DOC_PATH, 'src-unexpected.ts']);
    expect(state!.implementationRiskAssessment?.computedMinimumTaskClass).toBe('STANDARD');
    expect(state!.reducedCeremony).toBeNull();
    expect(state!.phase).toBe('IMPL_REVIEW');
  });
});

describe('team opt-in completion (real git)', () => {
  it('HAPPY: the reduced waiver reaches COMPLETE through the human gate and export', async () => {
    s = await boot({
      policyMode: 'team',
      claimedTaskClass: 'TRIVIAL',
      allowReducedCeremony: true,
    });
    const se = s;
    const hydrated = await readState(se.sDir);
    expect(hydrated!.policySnapshot.mode).toBe('team');
    expect(hydrated!.policySnapshot.requireHumanGates).toBe(true);
    expect(hydrated!.policySnapshot.effectiveGateBehavior).toBe('human_gated');
    expect(hydrated!.policySnapshot.allowReducedCeremony).toBe(true);
    expect(hydrated!.claimedTaskClass).toBe('TRIVIAL');

    // Preserve the REAL hydrated identities (id, flowguardSessionId, binding):
    // the completion archive is materialized under the host session id and the
    // offline verifier cross-checks state.binding against the manifest.
    await subjectState(se, false, hydrated!.policySnapshot, hydrated!);
    executorWritesReport();
    const check = await run_check.execute(RUN, se.tc);
    expect(String(check)).not.toContain('"error":true');

    let state = await readState(se.sDir);
    expect(state!.phase).toBe('EVIDENCE_REVIEW');
    expect(state!.reducedCeremony).toMatchObject({
      profile: 'reduced',
      reason: 'POST_IMPL_VERIFIED_TRIVIAL',
    });
    expect(state!.implReview).toBeNull();

    // Honest completeness: post-impl validation complete, review waived —
    // never a synthesized verdict.
    const completeness = evaluateCompleteness(state!);
    expect(completeness.slots.find((slot) => slot.slot === 'implValidation')?.detail).toBe(
      'post-impl 1/1 passed',
    );
    expect(completeness.slots.find((slot) => slot.slot === 'implReview')?.status).toBe('waived');
    expect(completeness.summary.waived).toBe(1);

    // The human evidence gate remains mandatory: approve → EXPORT_READY.
    recordUserDecisionIntent({
      sessionId: se.sId,
      command: '/approve',
      expectedVerdict: 'approve',
    });
    const approved = await decision.execute(
      { verdict: 'approve', rationale: 'human evidence gate' },
      se.tc,
    );
    expect(String(approved)).not.toContain('INTERNAL_ERROR');
    state = await readState(se.sDir);
    expect(state!.phase).toBe('EXPORT_READY');

    // Flush the canonical outbox into the audit trail (the host lifecycle does
    // this on tool boundaries) so the completion package carries the waiver.
    const auditDeps = createSessionCompletionAuditDeps({
      sessDir: se.sDir,
      sessionID: se.sId,
      fingerprint: se.fingerprint,
      state: state!,
    });
    await reconcilePendingAuditOperations(auditDeps, se.sId, 'flowguard_review_decision');

    // /export → COMPLETE with verifiable completion evidence.
    const completion = await exportTool.execute({}, se.tc);
    expect(String(completion)).not.toContain('INTERNAL_ERROR');
    state = await readState(se.sDir);
    expect(state!.phase).toBe('COMPLETE');
    expect(state!.exportCompletionEvidence).toMatchObject({
      purpose: 'auditor',
      integrityCapability: 'verifiable',
    });
    expect(state!.lastExportVerificationStatus).toBe('passed');

    // The canonical audit outbox durably carries the waiver decision with its
    // binding (the host lifecycle flushes it into the audit chain; the export
    // package snapshots the same state).
    const waiverEvents = state!.pendingAuditOperations.filter(
      (
        operation,
      ): operation is Extract<
        SessionState['pendingAuditOperations'][number],
        { kind: 'semantic' }
      > => operation.kind === 'semantic' && operation.semantic.event === 'reduced_ceremony_applied',
    );
    expect(waiverEvents).toHaveLength(1);
    expect(waiverEvents[0]!.semantic.detail).toMatchObject({
      status: 'applied',
      implementationId: state!.implementation!.implementationId,
      implementationDigest: state!.implementation!.digest,
    });

    // The completion package is named by the HOST session id and binds the
    // archived state to the same host id and fingerprint.
    const archivePath = join(
      se.configDir,
      'workspaces',
      se.fingerprint,
      'sessions',
      'archive',
      `${se.sId}.tar.gz`,
    );
    expect(existsSync(archivePath)).toBe(true);
    const members = execFileSync('tar', ['-tzf', archivePath], { encoding: 'utf-8' })
      .split('\n')
      .filter(Boolean);
    const stateMember = `${se.sId}/state/session-state.json`;
    const manifestMember = `${se.sId}/archive-manifest.json`;
    expect(members).toContain(stateMember);
    expect(members).toContain(manifestMember);
    const archivedState = JSON.parse(
      execFileSync('tar', ['-xOzf', archivePath, stateMember], { encoding: 'utf-8' }),
    ) as SessionState;
    const archivedManifest = JSON.parse(
      execFileSync('tar', ['-xOzf', archivePath, manifestMember], { encoding: 'utf-8' }),
    ) as { sessionId: string; fingerprint: string };
    expect(archivedManifest.sessionId).toBe(se.sId);
    expect(archivedManifest.fingerprint).toBe(se.fingerprint);
    expect(archivedState.id).toBe(hydrated!.id);
    expect(archivedState.flowguardSessionId).toBe(hydrated!.flowguardSessionId);
    expect(archivedState.binding.hostSessionId).toBe(se.sId);
    expect(archivedState.binding.fingerprint).toBe(se.fingerprint);

    // The archived audit trail carries the durable waiver event.
    const auditMember = members.find((member) => member.endsWith('/audit/audit.jsonl'));
    expect(auditMember).toBeDefined();
    expect(
      execFileSync('tar', ['-xOzf', archivePath, auditMember!], { encoding: 'utf-8' }),
    ).toContain('reduced_ceremony_applied');

    // Canonical SOURCE verification of the materialized archive (no build
    // required): the integration suite must stay runnable before `npm run
    // build`. The standalone CLI verifier on the concrete package runs
    // post-build in the smoke project
    // (src/cli/demo-evidence-verify.test.ts).
    const verification = await verifyArchive(se.fingerprint, se.sId);
    expect(verification.passed).toBe(true);
  });
});
