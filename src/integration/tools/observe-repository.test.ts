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
import { createReviewAttempt } from '../review/obligations/attempt-lifecycle.js';
import { createReviewObligation } from '../review/obligations/assurance.js';
import { mintObservationCapability } from '../review/obligations/attempt-lifecycle.js';
import {
  appendObservationCapture,
  observationCapabilityDigest,
  observationLedgerPath,
  observationLedgerRoot,
  readObservationCaptures,
} from '../../adapters/persistence-observation-ledger.js';
import {
  artifactReviewSubjectScope,
  freezeReviewMaterial,
} from '../review/obligations/assurance.js';
import {
  buildObservationToolResponse,
  contentDigestOf,
  repositoryIdentityDigest,
  responseDigestOf,
} from '../review/observations/observation-service.js';
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

vi.mock('../blocked-result.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../blocked-result.js')>();
  return {
    ...original,
    formatBlocked: vi.fn((code: string, params: Record<string, unknown>) =>
      JSON.stringify({ error: true, code, ...params }),
    ),
  };
});

vi.mock('./helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers.js')>();
  const makePaths = () => ({
    worktree,
    fingerprint: 'ab'.repeat(12),
    sessDir: path.join(LEDGER_HOME, 'sessions', 'unused'),
    wsDir: path.join(LEDGER_HOME, 'ws'),
  });
  return {
    ...original,
    // The tool resolves its workspace through the canonical authority now
    // (requireWorkspacePaths); the ledger fixture lives under the synthetic
    // fingerprint, so the stub keeps the deterministic mapping.
    requireWorkspacePaths: vi.fn(async () => makePaths()),
    resolveWorkspacePaths: vi.fn(async () => makePaths()),
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
      maxReviewerAttempts: 1,
    },
    obligationType: 'implement',
    reviewCycle: 1,
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
          currentDigest: null,
          persistedDigest: null,
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
      assuranceSchemaVersion: 'review-assurance.v7',
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

  // A context authority (plan/architecture) offers exactly "head".
  const contextObligation = createReviewObligation({
    obligationType: 'architecture',
    reviewCycle: 1,
    repositoryEvidenceFreeze: { kind: 'available' },
    iteration: 0,
    planVersion: 1,
    now: '2026-08-13T10:00:00.000Z',
    subjectDigest: 'adr-digest',
    reviewMaterial: freezeReviewMaterial('frozen review material', 'adr-digest'),
    reviewSubjectScope: artifactReviewSubjectScope(
      'adr',
      '## Context\nA\n## Decision\nB',
      'adr-digest',
    ),
    repositoryAuthority: {
      kind: 'context',
      context: {
        kind: 'commit',
        repositoryIdentity: { kind: 'local', rootCommitDigest: 'sha256:' + 'b'.repeat(64) },
        objectSha: baseSha,
      },
    },
  });
  const contextAttempt = createReviewAttempt({
    obligationId: contextObligation.obligationId,
    obligationType: 'architecture',
    subjectDigest: contextObligation.subjectDigest,
    ordinal: 1,
    origin: { kind: 'initial' },
    observationCapability: mintObservationCapability(),
    repositoryDiscovery: attempt.repositoryDiscovery,
    now: '2026-08-13T10:00:00.000Z',
  });
  const contextSessDir = path.join(LEDGER_HOME, 'ab'.repeat(12), 'sessions', 'context-session');
  fs.mkdirSync(contextSessDir, { recursive: true });
  fs.writeFileSync(
    path.join(contextSessDir, 'session-state.json'),
    JSON.stringify(
      {
        ...makeState('ARCH_REVIEW'),
        reviewAssurance: {
          assuranceSchemaVersion: 'review-assurance.v7',
          obligations: [contextObligation],
          invocations: [],
          attempts: [contextAttempt],
          dispatches: [],
        },
      },
      null,
      2,
    ) + '\n',
    'utf-8',
  );
  (globalThis as Record<string, unknown>).__CTX_CAPABILITY = contextAttempt.observationCapability;
  (globalThis as Record<string, unknown>).__CTX_OBLIGATION_ID = contextObligation.obligationId;
});

afterAll(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(LEDGER_HOME, { recursive: true, force: true });
});

describe('observe_repository', () => {
  it('HAPPY: delivers exact frozen bytes and appends a transport capture', async () => {
    const { observe_repository } = await import('./observe/observe-repository.js');
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
      lineCount?: number;
      content: string;
    };
    expect(parsed.path).toBe('src/foo.ts');
    expect(parsed.revision).toBe('head');
    expect(parsed.content).toBe('frozen-content\n');
    // The citable bound the evidence binder enforces, delivered up front.
    expect(parsed.lineCount).toBe(1);
    expect(Object.keys(parsed)).toEqual([
      'path',
      'revision',
      'representation',
      'lineCount',
      'content',
    ]);

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
    const { observe_repository } = await import('./observe/observe-repository.js');
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
    const { observe_repository } = await import('./observe/observe-repository.js');
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
    const { observe_repository } = await import('./observe/observe-repository.js');
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
    const { observe_repository } = await import('./observe/observe-repository.js');
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

  describe('context authority (plan/architecture): only "head" is offered', () => {
    const CONTEXT = {
      sessionID: 'context-child-session',
      messageID: 'm',
      agent: 'flowguard-reviewer',
      directory: '',
      worktree: '',
      abort: undefined,
      metadata: () => {},
    };

    it('HAPPY: the offered "head" delivers frozen context bytes', async () => {
      const { observe_repository } = await import('./observe/observe-repository.js');
      const capability = (globalThis as Record<string, unknown>).__CTX_CAPABILITY as string;
      const output = await observe_repository.execute(
        { capability, revision: 'head', path: 'src/foo.ts' },
        { ...CONTEXT, directory: worktree, worktree },
      );
      expect((JSON.parse(String(output)) as { content: string }).content).toBe('frozen-content\n');
    });

    it('BAD: "base" is rejected as not offered and names the offered "head"', async () => {
      const { observe_repository } = await import('./observe/observe-repository.js');
      const capability = (globalThis as Record<string, unknown>).__CTX_CAPABILITY as string;
      const output = await observe_repository.execute(
        { capability, revision: 'base', path: 'src/foo.ts' },
        { ...CONTEXT, directory: worktree, worktree },
      );
      expect(JSON.parse(String(output))).toEqual({
        error: true,
        code: 'REVIEW_OBSERVATION_REVISION_NOT_OFFERED',
        revision: 'base',
        obligationId: (globalThis as Record<string, unknown>).__CTX_OBLIGATION_ID,
        offeredRevisions: '"head"',
      });
      expect(String(output)).not.toContain('REVIEW_OBSERVATION_AUTHORITY_UNAVAILABLE');
    });
  });
});
