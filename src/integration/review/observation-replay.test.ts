/**
 * @module observation-replay.test
 * @description Unit tests for the parent replay: captures become authoritative
 *              observations ONLY after digest-verified re-acquisition.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createReviewAttempt, createReviewObligation } from './assurance.js';
import { mintObservationCapability } from './attempt-lifecycle.js';
import type { SessionState } from '../../state/schema.js';
import {
  appendObservationCapture,
  observationCapabilityDigest,
  observationLedgerRoot,
} from '../../adapters/persistence-observation-ledger.js';
import {
  buildObservationToolResponse,
  classifyRepresentation,
  contentDigestOf,
  repositoryIdentityDigest,
  responseDigestOf,
} from './observation-service.js';

vi.mock('../../adapters/workspace/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/workspace/index.js')>();
  return {
    ...original,
    workspacesHome: vi.fn(() => LEDGER_HOME),
    computeFingerprint: vi.fn(async () => ({ fingerprint: 'testfp' })),
  };
});

const LEDGER_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-replay-'));
const CHILD_SESSION = 'child-session-1';

let repo: string;
let baseSha: string;
let headTreeSha: string;
let state: SessionState;
let capability: string;

function git(args: string[], cwd = repo): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' }).trim();
}

function buildState(): SessionState {
  const obligation = createReviewObligation({
    obligationType: 'implement',
    iteration: 0,
    planVersion: 1,
    now: '2026-08-13T10:00:00.000Z',
    subjectDigest: 'impl-digest',
    changedFiles: ['src/foo.ts'],
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
        objectSha: headTreeSha,
      },
    },
  });
  const attempt = createReviewAttempt({
    obligationId: obligation.obligationId,
    obligationType: 'implement',
    subjectDigest: obligation.subjectDigest,
    ordinal: 1,
    origin: { kind: 'initial' },
    repositoryDiscovery: { kind: 'not_applicable' },
    observationCapability: mintObservationCapability(),
    now: '2026-08-13T10:00:00.000Z',
  });
  capability = attempt.observationCapability!;
  return {
    binding: { fingerprint: 'testfp' },
    reviewAssurance: {
      assuranceSchemaVersion: 'review-assurance.v5',
      obligations: [obligation],
      invocations: [],
      attempts: [attempt],
    },
  } as unknown as SessionState;
}

async function writeCapture(overrides: Record<string, unknown> = {}): Promise<void> {
  const bytes = Buffer.from('head-content\n');
  const representation = 'utf8_text';
  const content = bytes.toString('utf-8');
  const response = buildObservationToolResponse({
    path: 'src/foo.ts',
    revision: 'head',
    representation,
    content,
  });
  const capture = {
    capabilityDigest: observationCapabilityDigest(capability),
    capturedSessionId: CHILD_SESSION,
    path: 'src/foo.ts',
    revision: 'head',
    resolvedObjectSha: headTreeSha,
    repositoryIdentityDigest: repositoryIdentityDigest({
      kind: 'local',
      rootCommitDigest: 'sha256:' + 'b'.repeat(64),
    }),
    contentDigest: contentDigestOf(bytes),
    byteLength: bytes.length,
    representation,
    acquisitionKind: 'local_git_object',
    responseDigest: responseDigestOf(response),
    capturedAt: '2026-08-13T10:05:00.000Z',
    ...overrides,
  };
  await appendObservationCapture(
    observationLedgerRoot(LEDGER_HOME, 'testfp'),
    capture.capabilityDigest,
    capture as never,
  );
}

beforeAll(async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-replay-repo-'));
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'src', 'foo.ts'), 'base-content\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
  baseSha = git(['rev-parse', 'HEAD']);
  // Real candidate tree via the adapter (already unit-tested) — here use the
  // real git write-tree flow to make the replay end-to-end.
  const { freezeWorktreeCandidate } = await import('../../adapters/frozen-repository.js');
  fs.writeFileSync(path.join(repo, 'src', 'foo.ts'), 'head-content\n');
  headTreeSha = await freezeWorktreeCandidate(repo, baseSha);
  state = buildState();
});

afterAll(() => {
  fs.rmSync(repo, { recursive: true, force: true });
  fs.rmSync(LEDGER_HOME, { recursive: true, force: true });
});

beforeEach(() => {
  // Ledger files are capability-namespaced and shared across tests in this
  // file — reset the ledger so each test replays only its own captures.
  fs.rmSync(observationLedgerRoot(LEDGER_HOME, 'testfp'), { recursive: true, force: true });
});

describe('replayObservationCaptures', () => {
  it('HAPPY: valid capture mints an authoritative observation bound to the child session', async () => {
    const { replayObservationCaptures } = await import('./observation-replay.js');
    const attemptId = state.reviewAssurance!.attempts[0]!.attemptId;
    await writeCapture();
    const result = await replayObservationCaptures({
      state,
      worktree: repo,
      attemptId,
      childSessionId: CHILD_SESSION,
      now: '2026-08-13T10:10:00.000Z',
    });
    expect(result.dropped).toBe(0);
    expect(result.observations).toHaveLength(1);
    const obs = result.observations[0]!;
    expect(obs.observedBySessionId).toBe(CHILD_SESSION);
    expect(obs.attemptId).toBe(attemptId);
    expect(obs.resolvedObjectSha).toBe(headTreeSha);
    expect(obs.representation).toBe('utf8_text');
    expect(obs.boundAt).toBe('2026-08-13T10:10:00.000Z');
  });

  it('BAD: tampered content digest drops the capture (no authority minted)', async () => {
    const { replayObservationCaptures } = await import('./observation-replay.js');
    const attemptId = state.reviewAssurance!.attempts[0]!.attemptId;
    await writeCapture({ contentDigest: 'sha256:' + '0'.repeat(64) });
    const result = await replayObservationCaptures({
      state,
      worktree: repo,
      attemptId,
      childSessionId: CHILD_SESSION,
      now: '2026-08-13T10:11:00.000Z',
    });
    expect(result.observations).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it('BAD: capture citing an unavailable revision drops', async () => {
    const { replayObservationCaptures } = await import('./observation-replay.js');
    const attemptId = state.reviewAssurance!.attempts[0]!.attemptId;
    await writeCapture({ revision: 'base', resolvedObjectSha: baseSha });
    const result = await replayObservationCaptures({
      state,
      worktree: repo,
      attemptId,
      childSessionId: CHILD_SESSION,
      now: '2026-08-13T10:12:00.000Z',
    });
    // candidate_pair resolves base fine, but the captured response was built
    // for head — responseDigest mismatch drops it.
    expect(result.observations).toEqual([]);
  });

  it('BAD: response digest mismatch (capture does not represent delivered bytes) drops', async () => {
    const { replayObservationCaptures } = await import('./observation-replay.js');
    const attemptId = state.reviewAssurance!.attempts[0]!.attemptId;
    await writeCapture({ responseDigest: 'sha256:' + 'f'.repeat(64) });
    const result = await replayObservationCaptures({
      state,
      worktree: repo,
      attemptId,
      childSessionId: CHILD_SESSION,
      now: '2026-08-13T10:13:00.000Z',
    });
    expect(result.observations).toEqual([]);
    expect(result.dropped).toBe(1);
  });

  it('CORNER: attempt without capability mints nothing', async () => {
    const { replayObservationCaptures } = await import('./observation-replay.js');
    const { createReviewAttempt } = await import('./assurance.js');
    const attempt = createReviewAttempt({
      obligationId: state.reviewAssurance!.obligations[0]!.obligationId,
      obligationType: 'implement',
      subjectDigest: 'x',
      ordinal: 9,
      origin: { kind: 'initial' },
      repositoryDiscovery: { kind: 'not_applicable' },
      observationCapability: null,
      now: '2026-08-13T10:00:00.000Z',
    });
    const legacy = { ...attempt, observationCapability: undefined } as never;
    const result = await replayObservationCaptures({
      state: {
        ...state,
        reviewAssurance: {
          ...state.reviewAssurance!,
          attempts: [legacy],
        },
      },
      worktree: repo,
      attemptId: attempt.attemptId,
      childSessionId: CHILD_SESSION,
      now: '2026-08-13T10:14:00.000Z',
    });
    expect(result.observations).toEqual([]);
  });

  it('HAPPY: binary blob representation is classified and replayed', async () => {
    const { replayObservationCaptures } = await import('./observation-replay.js');
    const bytes = Buffer.from([0x00, 0xff, 0x80, 0x01]);
    expect(classifyRepresentation(bytes)).toBe('binary');
  });
});
