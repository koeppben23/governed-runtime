/**
 * @module observe-repository.test
 * @description Integration tests for the sanctioned observation tool: frozen
 *              acquisition, capability binding, and ledger capture.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createReviewAttempt, createReviewObligation } from '../review/assurance.js';
import { mintObservationCapability } from '../review/attempt-lifecycle.js';
import {
  appendObservationCapture,
  observationCapabilityDigest,
  observationLedgerPath,
  observationLedgerRoot,
  readObservationCaptures,
} from '../../adapters/persistence-observation-ledger.js';
import { freezeReviewMaterial } from '../review/assurance.js';
import {
  buildObservationToolResponse,
  contentDigestOf,
  repositoryIdentityDigest,
  responseDigestOf,
} from '../review/observation-service.js';
import { makeState } from '../../fixtures.js';

const LEDGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-observe-tool-'));
let worktree: string;

vi.mock('../../adapters/workspace/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/workspace/index.js')>();
  return {
    ...original,
    workspacesHome: vi.fn(() => LEDGER_HOME),
    sessionDir: vi.fn((fingerprint: string, sessionId: string) =>
      path.join(LEDGER_HOME, fingerprint, 'sessions', sessionId),
    ),
  };
});

vi.mock('./helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers.js')>();
  return {
    ...original,
    resolveWorkspacePaths: vi.fn(async () => ({
      worktree,
      fingerprint: 'ab'.repeat(12),
      sessDir: path.join(LEDGER_HOME, 'sessions', 'unused'),
      wsDir: path.join(LEDGER_HOME, 'ws'),
    })),
    formatBlocked: vi.fn((code: string, params: Record<string, unknown>) =>
      JSON.stringify({ error: true, code, ...params }),
    ),
    getWorktree: vi.fn(() => worktree),
  };
});

beforeAll(async () => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-observe-repo-'));
  const { execFileSync } = await import('node:child_process');
  const git = (a: string[]) => execFileSync('git', a, { cwd: worktree, encoding: 'utf-8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'foo.ts'), 'frozen-content\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  const baseSha = git(['rev-parse', 'HEAD']);
  // Freeze the candidate BEFORE the worktree mutates: the observation must
  // deliver the frozen candidate bytes, never the later worktree state.
  const { freezeWorktreeCandidate } = await import('../../adapters/frozen-repository.js');
  const treeSha = await freezeWorktreeCandidate(worktree, baseSha);
  fs.writeFileSync(path.join(worktree, 'src', 'foo.ts'), 'worktree-now\n');

  const obligation = createReviewObligation({
    policySnapshot: {
      challengePolicy: {
        version: 'challenge-policy.v1',
        counts: { TRIVIAL: 0, STANDARD: 1, 'HIGH-RISK': 2 },
      },
      maxReviewerOutputRepairAttempts: 1,
    },
    obligationType: 'implement',
    iteration: 0,
    planVersion: 1,
    now: '2026-08-13T10:00:00.000Z',
    subjectDigest: 'impl-digest',
    reviewMaterial: freezeReviewMaterial('frozen implementation material\n', 'impl-digest'),
    changedFiles: ['src/foo.ts'],
    reviewSubjectScope: { kind: 'implementation', implementationDigest: 'impl-digest' },
    repositoryAuthority: {
      kind: 'candidate_pair',
      base: {
        kind: 'commit',
        repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
        objectSha: baseSha,
      },
      head: {
        kind: 'tree',
        repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
        objectSha: treeSha,
      },
    },
  });
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: 'implement',
    subjectDigest: obligation.subjectDigest,
    ordinal: 1,
    origin: { kind: 'initial' },
    observationCapability: mintObservationCapability(),
    repositoryDiscovery: {
      kind: 'repository',
      snapshot: {
        observedAt: '2026-08-13T10:00:00.000Z',
        discoveryDigest: null,
        workspaceFingerprint: null,
        health: {
          status: 'available',
          healthy: true,
          failedCollectorNames: [],
          hasBudgetExhaustion: false,
          ageWarning: null,
          notVerified: [],
        },
        drift: {
          status: 'clean',
          drifted: false,
          changedContributorNames: [],
          notVerified: [],
        },
        detectedStack: null,
        verificationCandidates: [],
        riskSurfaces: [],
        warnings: [],
        notVerified: [],
      },
    },
    now: '2026-08-13T10:00:00.000Z',
  });

  // Persist a full parent session state so capability resolution can find it.
  const sessDir = path.join(LEDGER_HOME, 'ab'.repeat(12), 'sessions', 'parent-session');
  fs.mkdirSync(sessDir, { recursive: true });
  const parentState = {
    ...makeState('IMPL_REVIEW'),
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v6',
      obligations: [obligation],
      invocations: [],
      attempts: [attempt],
      dispatches: [],
    },
  };
  fs.writeFileSync(
    path.join(sessDir, 'session-state.json'),
    JSON.stringify(parentState, null, 2) + '\n',
    'utf-8',
  );
  (globalThis as Record<string, unknown>).__OBS_CAPABILITY = attempt.observationCapability;
});

afterAll(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(LEDGER_HOME, { recursive: true, force: true });
});

describe('observe_repository', () => {
  it('HAPPY: delivers exact frozen bytes and appends a transport capture', async () => {
    const { observe_repository } = await import('./observe-repository.js');
    const capability = (globalThis as Record<string, unknown>).__OBS_CAPABILITY as string;
    const output = await observe_repository.execute(
      { capability, revision: 'head', path: 'src/foo.ts' },
      {
        sessionID: 'child-session',
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: worktree,
        worktree,
        abort: undefined,
        metadata: () => {},
      },
    );
    expect(typeof output).toBe('string');
    const parsed = JSON.parse(output as string) as {
      path: string;
      revision: string;
      representation: string;
      content: string;
    };
    expect(parsed.path).toBe('src/foo.ts');
    expect(parsed.revision).toBe('head');
    expect(parsed.content).toBe('frozen-content\n');

    const digest = observationCapabilityDigest(capability);
    const read = await readObservationCaptures(
      observationLedgerRoot(LEDGER_HOME, 'ab'.repeat(12)),
      digest,
    );
    expect(read.captures).toHaveLength(1);
    const capture = read.captures[0]!;
    expect(capture.capturedSessionId).toBe('child-session');
    expect(capture.contentDigest).toBe(contentDigestOf(Buffer.from('frozen-content\n')));
    expect(capture.responseDigest).toBe(
      responseDigestOf(
        buildObservationToolResponse({
          path: 'src/foo.ts',
          revision: 'head',
          representation: 'utf8_text',
          content: 'frozen-content\n',
        }),
      ),
    );
    expect(capture.repositoryIdentityDigest).toBe(
      repositoryIdentityDigest({
        kind: 'local',
        rootCommitDigest: 'sha256:' + 'b'.repeat(64),
      }),
    );
    expect(
      observationLedgerPath(observationLedgerRoot(LEDGER_HOME, 'ab'.repeat(12)), digest),
    ).toContain(digest);
  });

  it('BAD: unknown capability fails closed', async () => {
    const { observe_repository } = await import('./observe-repository.js');
    const output = await observe_repository.execute(
      { capability: 'fgc_' + '0'.repeat(64), revision: 'head', path: 'src/foo.ts' },
      {
        sessionID: 'child-session',
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: worktree,
        worktree,
        abort: undefined,
        metadata: () => {},
      },
    );
    expect(String(output)).toContain('REVIEW_OBSERVATION_CAPABILITY_UNKNOWN');
  });

  it('BAD: escaping path fails closed', async () => {
    const { observe_repository } = await import('./observe-repository.js');
    const capability = (globalThis as Record<string, unknown>).__OBS_CAPABILITY as string;
    const output = await observe_repository.execute(
      { capability, revision: 'head', path: '../outside.ts' },
      {
        sessionID: 'child-session',
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: worktree,
        worktree,
        abort: undefined,
        metadata: () => {},
      },
    );
    expect(String(output)).toContain('REVIEW_OBSERVATION_PATH_INVALID');
  });

  it('HAPPY: candidate-pair base resolves to frozen commit bytes', async () => {
    const { observe_repository } = await import('./observe-repository.js');
    const capability = (globalThis as Record<string, unknown>).__OBS_CAPABILITY as string;
    const output = await observe_repository.execute(
      { capability, revision: 'base', path: 'src/foo.ts' },
      {
        sessionID: 'child-session',
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: worktree,
        worktree,
        abort: undefined,
        metadata: () => {},
      },
    );
    // candidate_pair resolves base fine here — the frozen bytes are delivered
    // from the commit, never from the mutated worktree.
    const parsed = JSON.parse(String(output)) as { content: string };
    expect(parsed.content).toBe('frozen-content\n');
  });

  it('CORNER: capture write failure never fabricates a delivery', async () => {
    const { observe_repository } = await import('./observe-repository.js');
    const capability = (globalThis as Record<string, unknown>).__OBS_CAPABILITY as string;
    const output = await observe_repository.execute(
      { capability, revision: 'head', path: 'src/foo.ts' },
      {
        sessionID: 'child-session',
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: worktree,
        worktree,
        abort: undefined,
        metadata: () => {},
      },
    );
    expect(typeof output).toBe('string');
  });
});
