/**
 * @module architecture-observation-acceptance.test
 * @description End-to-end acceptance for the architecture observation trust
 *              chain with a REAL Git repository and the REAL freeze path:
 *
 *              git init + commit
 *              → Mode A architecture obligation with frozen context authority
 *              → allowed revisions == ["head"]
 *              → reviewer observe_repository(head, path) delivers frozen bytes
 *              → RepositoryObservation replay materializes on the attempt
 *              → artifact_section finding + repository evidenceLocation(head)
 *              → bindOutcome = bound
 *
 *              Negative counterpart: no resolvable repository authority
 *              → no observation capability on the attempt
 *              → response surfaces an explicit repositoryEvidence warning
 *              → observe_repository fails closed
 *              → artifact-only findings still bind.
 *
 * @test-policy HAPPY, BAD
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import type { SessionState } from '../../state/schema.js';
import type { FlowGuardPolicy } from '../../config/policy-types.js';
import { makeState, POLICY_SNAPSHOT, FIXED_FINGERPRINT } from '../../fixtures.js';
import { makeDiscoveryResult } from '../../discovery/discovery-test-fixtures.js';
import { TEAM_POLICY } from '../../config/policy-presets.js';
import { readState } from '../../adapters/persistence.js';
import { createPolicyContext } from './helpers.js';
import { handleAdrSubmission } from './architecture-submit.js';
import { routeArchitectureInitialSubmission } from './architecture-restart.js';
import { indexMarkdownSections } from '../../shared/markdown-sections.js';
import { REVIEWER_SUBAGENT_TYPE } from '../../shared/flowguard-identifiers.js';
import { TOOL_FLOWGUARD_ARCHITECTURE } from '../tool-names.js';
import { replayObservationCaptures } from '../review/observation-replay.js';
import { buildHostTaskEvidence } from '../review/evidence-binding.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from '../review/enforcement/enforcement.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
} from '../plugin-host-task-diagnostics-helpers.js';

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-arch-obs-'));
const FINGERPRINT = FIXED_FINGERPRINT;
const HAPPY_SESSION = 'acceptance-parent-session';
const NEGATIVE_SESSION = 'acceptance-negative-session';

let worktree: string;
let plainDir: string;

const ADR_TEXT =
  '## Context\n\nThe service lacks a structured task abstraction.\n\n' +
  '## Decision\n\nIntroduce a TaskService owning task lifecycle.\n\n' +
  '## Consequences\n\nCallers use TaskService instead of ad-hoc writes.\n';

vi.mock('../../adapters/workspace/index.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/workspace/index.js')>();
  return {
    ...original,
    workspacesHome: vi.fn(() => TEST_HOME),
    sessionDir: vi.fn((fingerprint: string, sessionId: string) =>
      path.join(TEST_HOME, fingerprint, 'sessions', sessionId),
    ),
  };
});

vi.mock('../../adapters/persistence-discovery.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../adapters/persistence-discovery.js')>();
  return {
    ...original,
    readDiscovery: vi.fn(async () => makeDiscoveryResult()),
  };
});

vi.mock('./helpers.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./helpers.js')>();
  return {
    ...original,
    resolveWorkspacePaths: vi.fn(async () => ({
      worktree,
      fingerprint: FINGERPRINT,
      sessDir: path.join(TEST_HOME, FINGERPRINT, 'sessions', HAPPY_SESSION),
      wsDir: worktree,
    })),
    getWorktree: vi.fn(() => worktree),
  };
});

function acceptanceSession(
  sessDir: string,
  wsDir: string,
): {
  worktree: string;
  fingerprint: string;
  sessDir: string;
  wsDir: string;
  state: SessionState;
  policy: FlowGuardPolicy;
  ctx: ReturnType<typeof createPolicyContext>;
} {
  const policy: FlowGuardPolicy = {
    ...TEAM_POLICY,
    reviewInvocationPolicy: 'host_task_required',
    selfReview: { ...TEAM_POLICY.selfReview, subagentEnabled: true },
  };
  const state = makeState('READY', {
    policySnapshot: {
      ...POLICY_SNAPSHOT,
      reviewInvocationPolicy: 'host_task_required',
      challengePolicy: TEAM_POLICY.challengePolicy,
    },
  });
  fs.mkdirSync(sessDir, { recursive: true });
  return {
    worktree: wsDir,
    fingerprint: FINGERPRINT,
    sessDir,
    wsDir,
    state,
    policy,
    ctx: createPolicyContext(policy),
  };
}

function designChallenge(obligationId: string, adrDigest: string): Record<string, unknown> {
  const section = indexMarkdownSections(ADR_TEXT)[0]!;
  return {
    clientReference: 'c1',
    obligationId,
    kind: 'design_challenge',
    outcome: 'contradicted',
    scenario: 'The cited evidence does not support the claim.',
    claim: 'The reviewed artifact is supported by the cited evidence.',
    locations: ['src/foo.ts'],
    evidenceRefs: [
      {
        kind: 'plan_adr_section',
        artifactKind: 'adr',
        artifactDigest: adrDigest,
        sectionPath: section.sectionPath,
        excerptDigest: section.excerptDigest,
      },
    ],
  };
}

function reviewerOutput(
  obligationId: string,
  adrDigest: string,
  locations: unknown[],
  requiredChallengeCount: number,
): string {
  const section = indexMarkdownSections(ADR_TEXT)[0]!;
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [
      {
        severity: 'major',
        category: 'correctness',
        message: 'The decision contradicts the cited repository evidence.',
        relation: {
          subjectAnchors: [
            {
              kind: 'artifact_section',
              artifactKind: 'adr',
              artifactDigest: adrDigest,
              sectionPath: [
                {
                  headingDepth: section.headingDepth,
                  siblingIndex: section.siblingIndex,
                  headingText: section.headingText,
                },
              ],
            },
          ],
          evidenceLocations: locations,
        },
      },
    ],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: requiredChallengeCount > 0 ? [designChallenge(obligationId, adrDigest)] : [],
    attestation: { toolObligationId: obligationId },
  });
}

beforeAll(async () => {
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-arch-acc-repo-'));
  plainDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fg-arch-acc-plain-'));
  const git = (a: string[]) => execFileSync('git', a, { cwd: worktree, encoding: 'utf-8' }).trim();
  git(['init', '-q']);
  git(['config', 'user.email', 't@example.com']);
  git(['config', 'user.name', 'T']);
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.writeFileSync(path.join(worktree, 'src', 'foo.ts'), 'frozen-content\n');
  git(['add', '-A']);
  git(['commit', '-q', '-m', 'base']);
});

afterAll(() => {
  fs.rmSync(worktree, { recursive: true, force: true });
  fs.rmSync(plainDir, { recursive: true, force: true });
  fs.rmSync(TEST_HOME, { recursive: true, force: true });
});

describe('architecture observation acceptance', () => {
  it('HAPPY: real repo → context authority → observe(head) → artifact_section + evidenceLocation binds', async () => {
    const sessDir = path.join(TEST_HOME, FINGERPRINT, 'sessions', HAPPY_SESSION);
    const session = acceptanceSession(sessDir, worktree);
    const raw = await handleAdrSubmission({ title: 'ADR Test', adrText: ADR_TEXT }, session);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.phase).toBe('ARCHITECTURE');
    expect(parsed.repositoryEvidence).toBeUndefined();

    const persisted = await readState(sessDir);
    expect(persisted).not.toBeNull();
    const obligation = persisted!.reviewAssurance!.obligations.find(
      (o) => o.obligationType === 'architecture',
    );
    expect(obligation).toBeDefined();
    expect(obligation!.repositoryAuthority?.kind).toBe('context');
    expect(obligation!.repositoryEvidenceFreeze).toEqual({ kind: 'available' });
    const attempt = persisted!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligation!.obligationId,
    );
    expect(attempt).toBeDefined();
    expect(attempt!.observationCapability).toMatch(/^fgc_/);

    // The reviewer obtains the exact frozen bytes through the sanctioned tool.
    const { observe_repository } = await import('./observe-repository.js');
    const observeOutput = await observe_repository.execute(
      {
        capability: attempt!.observationCapability!,
        revision: 'head',
        path: 'src/foo.ts',
      },
      {
        sessionID: CHILD_SESSION_ID,
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: worktree,
        worktree,
        abort: undefined,
        metadata: () => {},
      },
    );
    const observed = JSON.parse(observeOutput as string) as { content: string; revision: string };
    expect(observed.revision).toBe('head');
    expect(observed.content).toBe('frozen-content\n');

    // Host replay materializes the authoritative observations onto the attempt.
    const replay = await replayObservationCaptures({
      state: persisted!,
      worktree,
      attemptId: attempt!.attemptId,
      childSessionId: CHILD_SESSION_ID,
      now: LATER,
    });
    expect(replay.observations).toHaveLength(1);

    // Host-task bind: artifact-anchored finding plus an observation-backed
    // repository evidenceLocation must bind against the frozen context.
    const bindAttempt = {
      ...attempt!,
      childSessionId: CHILD_SESSION_ID,
      observations: replay.observations,
    };
    const harnessState = createSessionState();
    onFlowGuardToolAfter(harnessState, TOOL_FLOWGUARD_ARCHITECTURE, {}, modeAResponse(0, 1), NOW);
    onTaskToolAfter(
      harnessState,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      reviewerOutput(
        obligation!.obligationId,
        parsed.adrDigest as string,
        [{ path: 'src/foo.ts', revision: 'head' }],
        obligation!.requiredChallengeCount ?? 0,
      ),
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID } },
    );
    const result = buildHostTaskEvidence(harnessState, SESSION_ID, LATER, {
      obligations: [obligation!],
      invocations: [],
      attempts: [bindAttempt],
    });
    expect(result.bindOutcome).toBe('bound');
  });

  it('BAD: no repository authority → no capability, explicit warning, observe fails closed, artifact-only bind still works', async () => {
    const sessDir = path.join(TEST_HOME, FINGERPRINT, 'sessions', NEGATIVE_SESSION);
    const session = acceptanceSession(sessDir, plainDir);
    const raw = await handleAdrSubmission({ title: 'ADR Test', adrText: ADR_TEXT }, session);
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(parsed.phase).toBe('ARCHITECTURE');
    const evidence = parsed.repositoryEvidence as
      { available: boolean; reason: string } | undefined;
    expect(evidence?.available).toBe(false);
    expect(evidence?.reason).toBe('repository_unavailable');

    const persisted = await readState(sessDir);
    const obligation = persisted!.reviewAssurance!.obligations.find(
      (o) => o.obligationType === 'architecture',
    );
    expect(obligation!.repositoryAuthority).toBeUndefined();
    expect(obligation!.repositoryEvidenceFreeze).toMatchObject({
      kind: 'unavailable',
      reason: 'repository_unavailable',
    });
    const attempt = persisted!.reviewAssurance!.attempts.find(
      (a) => a.obligationId === obligation!.obligationId,
    );
    expect(attempt).toBeDefined();
    expect(attempt!.observationCapability).toBeUndefined();

    // Durable degradation: a later continuation re-emits the exact persisted
    // freeze cause from the obligation, not from a lost local freeze result.
    const continuation = await routeArchitectureInitialSubmission(
      { title: 'ADR Test', adrText: ADR_TEXT },
      { ...session, state: persisted! },
    );
    expect(continuation).not.toBeNull();
    const reEmitted = JSON.parse(continuation!) as Record<string, unknown>;
    expect(reEmitted.repositoryEvidence).toMatchObject({
      available: false,
      reason: 'repository_unavailable',
    });
    expect(reEmitted.status).toBe('Architecture review is pending.');

    // No capability exists, so no observation invocation can ever succeed.
    const { observe_repository } = await import('./observe-repository.js');
    const blocked = await observe_repository.execute(
      { capability: 'fgc_' + '0'.repeat(64), revision: 'head', path: 'src/foo.ts' },
      {
        sessionID: CHILD_SESSION_ID,
        messageID: 'm',
        agent: 'flowguard-reviewer',
        directory: plainDir,
        worktree: plainDir,
        abort: undefined,
        metadata: () => {},
      },
    );
    expect(String(blocked)).toContain('REVIEW_OBSERVATION_CAPABILITY_UNKNOWN');

    // Artifact-only findings (no evidenceLocations) still bind.
    const harnessState = createSessionState();
    onFlowGuardToolAfter(harnessState, TOOL_FLOWGUARD_ARCHITECTURE, {}, modeAResponse(0, 1), NOW);
    onTaskToolAfter(
      harnessState,
      { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
      reviewerOutput(
        obligation!.obligationId,
        parsed.adrDigest as string,
        [],
        obligation!.requiredChallengeCount ?? 0,
      ),
      LATER,
      { metadata: { sessionID: CHILD_SESSION_ID } },
    );
    const result = buildHostTaskEvidence(harnessState, SESSION_ID, LATER, {
      obligations: [obligation!],
      invocations: [],
      attempts: [
        {
          ...attempt!,
          childSessionId: CHILD_SESSION_ID,
        },
      ],
    });
    expect(result.bindOutcome).toBe('bound');
  });
});
