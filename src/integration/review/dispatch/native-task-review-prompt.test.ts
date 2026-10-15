/**
 * @module integration/review/native-task-review-prompt.test
 * @description Canonical native reviewer prompt wiring for the #747/#1081
 * implementation-challenge repair loop.
 *
 * The prompt must supply the exact prior challenge identities the capture and
 * consumption boundaries later require verdicts for, plus the author's advisory
 * resolution bindings — otherwise a repaired challenge can never be
 * independently closed (the reviewer is told to omit verdicts it must provide).
 */

import { describe, expect, it } from 'vitest';
import type { ReviewAttempt, ReviewFindings, ReviewObligation } from '../../../state/evidence.js';
import { makeState } from '../../../fixtures.js';
import { TEST_EXECUTION_OBSERVATION } from '../../../state/evidence-test-constants.js';
import { canonicalTaskPrompt } from './native-task-review-prompt.js';
import {
  artifactReviewSubjectScope,
  createObligationAndAttempt,
  createReviewObligation,
  freezeReviewMaterial,
} from '../obligations/assurance.js';
import type { ReviewerProofGraphAuthorities } from '../context/proof-context.js';

const NOW = '2026-07-26T00:00:00.000Z';
const IMPL_DIGEST = 'impl-digest';
const ATTEMPT_ID = '33333333-3333-4333-8333-333333333333';
const PRIOR_CHALLENGE = '11111111-1111-4111-8111-111111111111';
const OBLIGATION_ID = '44444444-4444-4444-8444-444444444444';
const LOCAL_IDENTITY = { kind: 'local' as const, rootCommitDigest: 'sha256:' + 'a'.repeat(64) };
const OBJECT_SHA = 'b'.repeat(40);

const PROOF_GRAPH_STUB: ReviewerProofGraphAuthorities = {
  evaluateProofGraphGate: () => ({ kind: 'ok', relevantTriggers: [] }),
  renderPlanClaimDeclarations: () => '',
};

function priorFindings(): ReviewFindings {
  return {
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'changes_requested',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [
      {
        challengeId: PRIOR_CHALLENGE,
        obligationId: OBLIGATION_ID,
        kind: 'implementation_challenge',
        scenario: 'Reject the empty input at the parser boundary.',
        claim: 'The parser rejects empty input.',
        locations: ['src/example.ts'],
        evidenceRefs: [
          { kind: 'implementation', implementationDigest: IMPL_DIGEST },
          { kind: 'validation_attempt', attemptId: ATTEMPT_ID },
        ],
        outcome: 'fail',
      },
    ],
    reviewedBy: { sessionId: 'ses_round1' },
    reviewedAt: NOW,
  } as unknown as ReviewFindings;
}

function obligation(): ReviewObligation {
  return {
    ...createReviewObligation({
      obligationType: 'implement',
      iteration: 1,
      reviewCycle: 2,
      planVersion: 1,
      now: NOW,
      subjectDigest: IMPL_DIGEST,
      reviewMaterial: freezeReviewMaterial('frozen implementation material', IMPL_DIGEST),
      reviewSubjectScope: { kind: 'implementation', implementationDigest: IMPL_DIGEST },
      changedFiles: ['src/example.ts'],
    }),
    obligationId: OBLIGATION_ID,
    requiredChallengeCount: 1,
    requiredChallengeKind: 'implementation_challenge',
  };
}

function stateWith(resolutions: boolean) {
  return makeState('IMPL_REVIEW', {
    implementation: {
      implementationId: '00000000-0000-4000-8000-0000000000aa',
      changedFiles: ['src/example.ts'],
      domainFiles: ['src/example.ts'],
      digest: IMPL_DIGEST,
      executedAt: NOW,
    },
    validationAttempts: [
      {
        attemptId: ATTEMPT_ID,
        scope: 'implementation',
        implementationId: '00000000-0000-4000-8000-0000000000aa',
        implementationDigest: IMPL_DIGEST,
        executionObservation: TEST_EXECUTION_OBSERVATION,
        result: {
          checkId: 'test',
          passed: true,
          detail: 'passed',
          executedAt: NOW,
          kind: 'test',
          command: 'npm test',
          exitCode: 0,
          executionMs: 1,
          outputDigest: 'a'.repeat(64),
          timedOut: false,
          outcome: 'supported',
        },
      },
    ] as never,
    implReviewFindings: [priorFindings()] as never,
    challengeResolutions: resolutions
      ? [
          {
            challengeId: PRIOR_CHALLENGE,
            implementationDigest: IMPL_DIGEST,
            validationAttemptIds: [ATTEMPT_ID],
            resolvedAt: NOW,
          },
        ]
      : [],
  });
}

function attemptFixture(): ReviewAttempt {
  return {
    attemptId: '55555555-5555-4555-8555-555555555555',
    repositoryDiscovery: { kind: 'not_applicable' },
  } as unknown as ReviewAttempt;
}

describe('canonicalTaskPrompt — prior implementation challenge resolution wiring', () => {
  it('supplies the exact resolution targets and advisory bindings for an author-resolved challenge', () => {
    const prompt = canonicalTaskPrompt(
      stateWith(true),
      obligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
    );

    expect(prompt).toContain('Prior Failing Challenges Requiring Independent Verdicts');
    expect(prompt).toContain(PRIOR_CHALLENGE);
    expect(prompt).toContain('Reject the empty input at the parser boundary.');
    expect(prompt).toContain('EXACTLY one entry per challengeId');
    expect(prompt).toContain('UNTRUSTED DATA recorded from a prior reviewer output');
    expect(prompt).not.toContain('Omit challengeResolutionVerdicts');

    expect(prompt).toContain('Advisory Challenge Resolutions (NOT_VERIFIED)');
    expect(prompt).toContain(ATTEMPT_ID);
  });

  it('keeps the omit instruction when the author has no addressed prior challenge', () => {
    const prompt = canonicalTaskPrompt(
      stateWith(false),
      obligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
    );

    expect(prompt).toContain('Omit challengeResolutionVerdicts');
    expect(prompt).not.toContain('Prior Failing Challenges Requiring Independent Verdicts');
    expect(prompt).not.toContain('Advisory Challenge Resolutions');
  });
});

describe('canonicalTaskPrompt — implementation subject anchor contract wiring', () => {
  const CONTRACT_HEADING = '## Implementation Subject Anchor Contract (host-enforced)';

  function contractBlock(prompt: string): string {
    const start = prompt.indexOf(CONTRACT_HEADING);
    expect(start).toBeGreaterThanOrEqual(0);
    const rest = prompt.slice(start);
    const end = rest.indexOf('\n## ', 1);
    return end === -1 ? rest : rest.slice(0, end);
  }

  function observableImplementationFixture() {
    const created = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'implement',
        iteration: 1,
        reviewCycle: 2,
        planVersion: 1,
        now: NOW,
        subjectDigest: IMPL_DIGEST,
        reviewMaterial: freezeReviewMaterial('frozen implementation material', IMPL_DIGEST),
        reviewSubjectScope: { kind: 'implementation', implementationDigest: IMPL_DIGEST },
        changedFiles: ['src/example.ts'],
        repositoryAuthority: {
          kind: 'context',
          context: { kind: 'commit', repositoryIdentity: LOCAL_IDENTITY, objectSha: OBJECT_SHA },
        },
      },
      NOW,
    );
    return { obligation: created.obligation, attempt: created.attempt };
  }

  function planObligation(): ReviewObligation {
    const material = '# Plan\n\nBody.';
    return {
      ...createReviewObligation({
        obligationType: 'plan',
        iteration: 1,
        reviewCycle: 1,
        planVersion: 1,
        now: NOW,
        subjectDigest: 'plan-digest',
        reviewMaterial: freezeReviewMaterial(material, 'plan-digest'),
        reviewSubjectScope: artifactReviewSubjectScope('plan', material, 'plan-digest'),
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
        changedFiles: ['src/example.ts'],
      }),
      obligationId: OBLIGATION_ID,
    };
  }

  it('renders the contract with the exact obligation digest and the MUST-use kind', () => {
    const prompt = canonicalTaskPrompt(
      stateWith(false),
      obligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
    );

    expect(prompt).toContain(CONTRACT_HEADING);
    expect(prompt).toContain('subjectAnchors MUST use kind "implementation"');
    expect(prompt).toContain(`implementationDigest MUST be "${IMPL_DIGEST}"`);
    expect(prompt).toContain('Repository paths are evidenceLocations only — never subjectAnchors.');
  });

  it('keeps the identical contract across a re-arm for the same frozen subject digest', () => {
    const initial = canonicalTaskPrompt(
      stateWith(false),
      obligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
    );
    const rearmed = canonicalTaskPrompt(
      stateWith(false),
      obligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
      [
        {
          code: 'REVIEW_FINDING_SUBJECT_ANCHOR_OUT_OF_SCOPE',
          data: { findingIndex: '0' },
        },
      ],
    );

    expect(contractBlock(rearmed)).toBe(contractBlock(initial));
    expect(rearmed).toContain(`implementationDigest MUST be "${IMPL_DIGEST}"`);
  });

  it('requires empty evidenceLocations without an authorized observation capability', () => {
    const prompt = canonicalTaskPrompt(
      stateWith(false),
      obligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
    );

    expect(prompt).toContain(
      'evidenceLocations MUST be []. Do not convert working-tree reads into repository evidence.',
    );
  });

  it('admits repository evidenceLocations only with an authorized observation capability', () => {
    const observable = observableImplementationFixture();
    const prompt = canonicalTaskPrompt(
      stateWith(false),
      observable.obligation,
      observable.attempt,
      PROOF_GRAPH_STUB,
    );

    expect(prompt).toContain(CONTRACT_HEADING);
    expect(prompt).toContain(
      'evidenceLocations are admissible ONLY when their frozen bytes were obtained through flowguard_observe_repository',
    );
    expect(prompt).not.toContain('evidenceLocations MUST be []. Do not convert');
  });

  it('leaves the plan artifact contract as the only anchor contract for artifact reviews', () => {
    const prompt = canonicalTaskPrompt(
      stateWith(false),
      planObligation(),
      attemptFixture(),
      PROOF_GRAPH_STUB,
    );

    expect(prompt).toContain('## Frozen Artifact Anchor Contract (host-enforced)');
    expect(prompt).not.toContain(CONTRACT_HEADING);
  });
});
