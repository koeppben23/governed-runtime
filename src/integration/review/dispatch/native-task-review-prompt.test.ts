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
import { ARCHITECTURE_DECISION, PLAN_RECORD, makeState } from '../../../fixtures.js';
import { validateAdrSections } from '../../../state/evidence-architecture.js';
import { hashText } from '../../../shared/hashing.js';
import { renderPlanClaimDeclarations } from '../../../presentation/plan-claim-declarations.js';
import { buildFrozenArtifactReviewMaterial } from '../context/reviewer-context.js';
import { artifactReviewSubjectScopeFromSections } from '../context/subject-scope.js';
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

const PROOF_GRAPH_RISK_STUB: ReviewerProofGraphAuthorities = {
  evaluateProofGraphGate: () => ({
    kind: 'risk_trigger_uncovered',
    relevantTriggers: ['command_contract'],
    uncoveredTriggers: ['command_contract'],
  }),
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

describe('canonicalTaskPrompt — separately declared architecture claims', () => {
  it('keeps plan declarations exactly once in their frozen material', () => {
    const declaration = {
      claimId: '11111111-1111-4111-8111-111111111111',
      statement: 'The store rejects writes without ownership.',
      critical: true,
      authoritySectionId: 'Invariant',
      claimScope: 'specific_behavior' as const,
      expectedCheckId: 'test',
    };
    const declarations = { flow: 'plan' as const, version: 'v2' as const, claims: [declaration] };
    const state = makeState('PLAN_REVIEW', {
      plan: { ...PLAN_RECORD, claimDeclarations: declarations },
    });
    const material = buildFrozenArtifactReviewMaterial({
      obligationType: 'plan',
      state,
      artifact: PLAN_RECORD.current.body,
      renderPlanClaimDeclarations,
      planClaimDeclarations: declarations,
    });
    const digest = PLAN_RECORD.current.digest;
    const created = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'plan',
        iteration: 0,
        reviewCycle: 1,
        planVersion: 1,
        now: NOW,
        subjectDigest: digest,
        reviewMaterial: freezeReviewMaterial(material.content, digest),
        reviewSubjectScope: artifactReviewSubjectScopeFromSections(
          'plan',
          material.subjectSectionPaths,
          digest,
        ),
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      },
      NOW,
    );
    const prompt = canonicalTaskPrompt(state, created.obligation, created.attempt, {
      ...PROOF_GRAPH_STUB,
      renderPlanClaimDeclarations,
    });
    expect(material.content).toContain(declaration.statement);
    expect(prompt.split(declaration.statement)).toHaveLength(2);
    expect(prompt.split('Positive evidence check: test')).toHaveLength(2);
  });

  it('supplies every declaration even when a valid MADR does not repeat its fields', () => {
    const adrText = [
      '# ADR-1: Storage ownership',
      '## Context',
      'Adapters need a narrow interface for access to stored records.',
      '## Considered Options',
      '- Put policy in each adapter.',
      '- Keep policy in a dedicated storage component.',
      '## Decision',
      'A dedicated storage component owns updates; adapters use its interface.',
      '## Consequences',
      'Policy has one owner, at the cost of an explicit module boundary.',
    ].join('\n');
    expect(validateAdrSections(adrText)).toEqual([]);
    const claims = [
      {
        claimId: '11111111-1111-4111-8111-111111111111',
        statement: 'Every write goes through the storage owner.',
        critical: true,
        authoritySectionId: 'Decision',
        requiredReviewEvidence: ['independent-writer-review', 'failure-path-review'],
        assumptions: ['Storage ownership is exclusive.'],
      },
      {
        claimId: '22222222-2222-4222-8222-222222222222',
        statement: 'Read adapters do not define write policy.',
        critical: false,
        authoritySectionId: 'Decision',
        requiredReviewEvidence: ['read-adapter-review'],
        assumptions: ['Read adapters have no mutation side effects.'],
      },
    ];
    const digest = hashText(adrText);
    const state = makeState('ARCH_REVIEW', {
      architecture: {
        ...ARCHITECTURE_DECISION,
        adrText,
        digest,
        claimDeclarations: { flow: 'architecture', claims },
      },
    });
    const material = buildFrozenArtifactReviewMaterial({
      obligationType: 'architecture',
      state,
      artifact: adrText,
      renderPlanClaimDeclarations,
    });
    const created = createObligationAndAttempt(
      undefined,
      {
        obligationType: 'architecture',
        iteration: 0,
        reviewCycle: 1,
        planVersion: 1,
        now: NOW,
        subjectDigest: digest,
        reviewMaterial: freezeReviewMaterial(material.content, digest),
        reviewSubjectScope: artifactReviewSubjectScopeFromSections(
          'adr',
          material.subjectSectionPaths,
          digest,
        ),
        repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
      },
      NOW,
    );
    const prompt = canonicalTaskPrompt(state, created.obligation, created.attempt, {
      ...PROOF_GRAPH_STUB,
      renderPlanClaimDeclarations,
    });
    for (const claim of claims) {
      for (const value of [
        claim.claimId,
        claim.statement,
        ...claim.requiredReviewEvidence,
        ...claim.assumptions,
      ]) {
        expect(material.content).not.toContain(value);
        expect(prompt.split(value)).toHaveLength(2);
      }
    }
    expect(prompt).toContain('These are stated intent, NOT evidence.');
    expect(prompt).toContain('artifactKind MUST be "adr"');
    expect(prompt).toContain(digest);
  });
});

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

describe('canonicalTaskPrompt — evidence dossier experiment', () => {
  it('keeps baseline output and adds the dossier only in the selected arm', () => {
    const state = stateWith(false);
    const currentObligation = obligation();
    const currentAttempt = {
      ...attemptFixture(),
      obligationId: currentObligation.obligationId,
      subjectDigest: currentObligation.subjectDigest,
    } as ReviewAttempt;
    const baseline = canonicalTaskPrompt(
      state,
      currentObligation,
      currentAttempt,
      PROOF_GRAPH_STUB,
    );
    const dossier = canonicalTaskPrompt(
      state,
      currentObligation,
      currentAttempt,
      PROOF_GRAPH_RISK_STUB,
      undefined,
      'dossier',
    );
    expect(baseline).toContain('## ProofGraph Context (persisted, advisory)');
    expect(baseline).not.toContain('## Evidence Dossier');
    expect(dossier).toContain('## Evidence Dossier (derived, advisory, untrusted)');
    expect(dossier.match(/## ProofGraph Context \(persisted, advisory\)/g)).toHaveLength(1);
    expect(dossier).toContain('binding":"bound_current"');
    expect(dossier).toContain('command_contract');
    expect(dossier).toContain('Triggers without approved critical-claim coverage');
    expect(dossier.indexOf('## Evidence Dossier')).toBeLessThan(
      dossier.indexOf('persisted review material below this line:'),
    );
  });
});
