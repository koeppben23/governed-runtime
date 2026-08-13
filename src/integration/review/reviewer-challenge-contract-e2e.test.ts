/**
 * @module integration/review-reviewer-challenge-contract-e2e.test
 * @description Closes the loop between what FlowGuard ASKS a reviewer to emit
 * and what FlowGuard ACCEPTS at binding time.
 *
 * Regression cover for the challenge-identity contract break: the canonical
 * reviewer prompt was switched to ask for a `clientReference` slug while the
 * binding gate still required a `challengeId`, and the normalization step that
 * maps one onto the other was written but never invoked. Every prompt-compliant
 * reviewer output was therefore rejected as `schema_invalid`.
 *
 * The decisive property under test: a challenge built VERBATIM from the shape
 * the prompt emits must bind. No test previously asserted that the emitter and
 * the validator agree, so the two halves could drift apart silently.
 *
 * @test-policy HAPPY, BAD, EDGE, REGRESSION, E2E — all categories present.
 */

import { describe, it, expect } from 'vitest';
import { renderReviewerTaskPrompt } from './prompt-builders.js';
import { buildHostTaskEvidence } from './evidence-binding.js';
import {
  createSessionState,
  onFlowGuardToolAfter,
  onTaskToolAfter,
} from './enforcement/enforcement.js';
import { REVIEWER_SUBAGENT_TYPE } from './enforcement/types.js';
import { REVIEW_CRITERIA_VERSION, REVIEW_MANDATE_DIGEST } from './assurance.js';
import {
  TOOL_FLOWGUARD_ARCHITECTURE,
  TOOL_FLOWGUARD_IMPLEMENT,
  TOOL_FLOWGUARD_PLAN,
  TOOL_FLOWGUARD_REVIEW,
} from '../tool-names.js';
import type { ReviewObligation } from '../../state/evidence.js';
import { ReviewerChallengeInput } from '../../state/evidence-review.js';
import {
  NOW,
  LATER,
  SESSION_ID,
  CHILD_SESSION_ID,
  modeAResponse,
  validPrompt,
  pendingObligation,
  attemptFor,
} from '../plugin-host-task-diagnostics-helpers.js';

const OBLIGATION_ID = '11111111-1111-4111-8111-111111111111';

const PLAN_SECTION_REF = {
  kind: 'plan_adr_section',
  artifactKind: 'plan',
  artifactDigest: 'plan-digest',
  sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Approach' }],
  excerptDigest: 'plan-excerpt-digest',
};

const ADR_SECTION_REF = {
  kind: 'plan_adr_section',
  artifactKind: 'adr',
  artifactDigest: 'adr-digest',
  sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
  excerptDigest: 'adr-excerpt-digest',
};

const IMPLEMENTATION_REFS = [
  { kind: 'implementation', implementationDigest: 'impl-digest' },
  { kind: 'validation_attempt', attemptId: '33333333-3333-4333-8333-333333333333' },
];

const CONTENT_REF = { kind: 'content', digest: 'content-digest' };

/**
 * Every obligation type that reaches host-task binding, with the challenge kind
 * and evidence-reference shape the host actually supplies for it.
 */
const CONTRACT_CASES = [
  {
    label: 'plan',
    tool: TOOL_FLOWGUARD_PLAN,
    obligationType: 'plan' as const,
    challengeKind: 'design_challenge' as const,
    evidenceRefs: [PLAN_SECTION_REF],
  },
  {
    label: 'architecture',
    tool: TOOL_FLOWGUARD_ARCHITECTURE,
    obligationType: 'architecture' as const,
    challengeKind: 'design_challenge' as const,
    evidenceRefs: [ADR_SECTION_REF],
  },
  {
    label: 'implement',
    tool: TOOL_FLOWGUARD_IMPLEMENT,
    obligationType: 'implement' as const,
    challengeKind: 'implementation_challenge' as const,
    evidenceRefs: IMPLEMENTATION_REFS,
  },
  {
    label: 'review',
    tool: TOOL_FLOWGUARD_REVIEW,
    obligationType: 'review' as const,
    challengeKind: 'content_challenge' as const,
    evidenceRefs: [CONTENT_REF],
  },
];

/** Extract the challenge object the canonical prompt tells the reviewer to produce. */
function challengeShapeFromPrompt(prompt: string): Record<string, unknown> {
  const match = prompt.match(/Required challenge object shape: (.+)/);
  expect(match, 'prompt must publish a challenge object shape').not.toBeNull();
  return JSON.parse(match![1]!) as Record<string, unknown>;
}

/**
 * Render the canonical prompt, then fill in ONLY the free-text placeholders a
 * reviewer is expected to replace. Every structural field — including the
 * identity contract — is carried over exactly as the prompt emitted it.
 */
function reviewerChallengeFromPrompt(
  challengeKind: (typeof CONTRACT_CASES)[number]['challengeKind'],
  evidenceRefs: readonly Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  const prompt = renderReviewerTaskPrompt({
    iteration: 0,
    planVersion: 1,
    obligationId: OBLIGATION_ID,
    mandateDigest: REVIEW_MANDATE_DIGEST,
    criteriaVersion: REVIEW_CRITERIA_VERSION,
    subjectLabel: 'the artifact under review',
    challengeContract: {
      requiredChallengeCount: 1,
      requiredChallengeKind: challengeKind,
      evidenceRefs: [...evidenceRefs],
    },
  });
  return {
    ...challengeShapeFromPrompt(prompt),
    scenario: 'Assume the cited evidence does not support the claim.',
    claim: 'The reviewed artifact is supported by the cited evidence.',
    locations: ['src/example.ts'],
    ...overrides,
  };
}

function reviewerOutput(challenges: readonly unknown[]): string {
  return JSON.stringify({
    iteration: 0,
    planVersion: 1,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    reviewedBy: { sessionId: CHILD_SESSION_ID },
    reviewedAt: NOW,
    attestation: {
      toolObligationId: OBLIGATION_ID,
      mandateDigest: REVIEW_MANDATE_DIGEST,
      criteriaVersion: REVIEW_CRITERIA_VERSION,
      iteration: 0,
      planVersion: 1,
      reviewedBy: REVIEWER_SUBAGENT_TYPE,
    },
    challenges,
  });
}

function bind(
  tool: string,
  obligation: ReviewObligation,
  challenges: readonly unknown[],
  childSessionId: string = CHILD_SESSION_ID,
) {
  const state = createSessionState();
  onFlowGuardToolAfter(state, tool, {}, modeAResponse(0, 1), NOW);
  onTaskToolAfter(
    state,
    { subagent_type: REVIEWER_SUBAGENT_TYPE, prompt: validPrompt(0, 1) },
    reviewerOutput(challenges),
    LATER,
  );
  return buildHostTaskEvidence(state, SESSION_ID, LATER, {
    obligations: [obligation],
    invocations: [],
    attempts: [attemptFor(obligation, childSessionId)],
  });
}

function obligationFor(
  obligationType: ReviewObligation['obligationType'],
  challengeKind: (typeof CONTRACT_CASES)[number]['challengeKind'],
  requiredChallengeCount = 1,
): ReviewObligation {
  return pendingObligation({
    obligationId: OBLIGATION_ID,
    obligationType,
    requiredChallengeCount,
    requiredChallengeKind: challengeKind,
  });
}

describe('reviewer challenge contract: what the prompt asks for is what binding accepts', () => {
  describe.each(CONTRACT_CASES)(
    '$label obligation / $challengeKind',
    ({ tool, obligationType, challengeKind, evidenceRefs }) => {
      it('HAPPY — binds a challenge built verbatim from the emitted prompt shape', () => {
        const challenge = reviewerChallengeFromPrompt(challengeKind, evidenceRefs);
        const result = bind(tool, obligationFor(obligationType, challengeKind), [challenge]);

        expect(result.bindOutcome).toBe('bound');
        expect(result.evidence).not.toBeNull();
      });

      it('REGRESSION — the emitted shape carries no challengeId, and the host mints one', () => {
        const challenge = reviewerChallengeFromPrompt(challengeKind, evidenceRefs);
        // The contract break this suite exists for: the prompt asks for a slug,
        // so the reviewer cannot supply the identity the schema demands.
        expect(challenge).not.toHaveProperty('challengeId');
        expect(challenge.clientReference).toBe('c1');

        const result = bind(tool, obligationFor(obligationType, challengeKind), [challenge]);
        const bound = result.evidence?.capturedRawFindings as
          { challenges?: { challengeId?: string; clientReference?: string }[] } | undefined;

        expect(bound?.challenges).toHaveLength(1);
        expect(bound?.challenges?.[0]?.challengeId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
        );
        // The reviewer's own reference survives for audit correlation.
        expect(bound?.challenges?.[0]?.clientReference).toBe('c1');
      });

      it('EDGE — a reviewer-supplied challengeId is discarded, never trusted', () => {
        const forged = '99999999-9999-4999-8999-999999999999';
        const challenge = reviewerChallengeFromPrompt(challengeKind, evidenceRefs, {
          challengeId: forged,
        });
        const result = bind(tool, obligationFor(obligationType, challengeKind), [challenge]);
        const bound = result.evidence?.capturedRawFindings as
          { challenges?: { challengeId?: string }[] } | undefined;

        expect(result.bindOutcome).toBe('bound');
        expect(bound?.challenges?.[0]?.challengeId).not.toBe(forged);
      });

      it('EDGE — a challenge naming a foreign obligation is stamped to the bound one', () => {
        const challenge = reviewerChallengeFromPrompt(challengeKind, evidenceRefs, {
          obligationId: '44444444-4444-4444-8444-444444444444',
        });
        const result = bind(tool, obligationFor(obligationType, challengeKind), [challenge]);
        const bound = result.evidence?.capturedRawFindings as
          { challenges?: { obligationId?: string }[] } | undefined;

        expect(result.bindOutcome).toBe('bound');
        expect(bound?.challenges?.[0]?.obligationId).toBe(OBLIGATION_ID);
      });
    },
  );
});

describe('the emitted prompt shape satisfies the canonical reviewer input contract', () => {
  // Schema-level counterpart to the binding tests above. `ReviewerChallengeInput`
  // is derived from the canonical `ReviewChallenge`, so this fails the moment the
  // prompt and the binding authority drift apart again — the exact failure mode
  // that a hand-maintained input schema hid, because its flat outcome enum could
  // not express an implementation challenge at all.
  it.each(CONTRACT_CASES)(
    '$label — the shape the prompt publishes parses as ReviewerChallengeInput',
    ({ challengeKind, evidenceRefs }) => {
      const challenge = reviewerChallengeFromPrompt(challengeKind, evidenceRefs);
      const parsed = ReviewerChallengeInput.safeParse(challenge);

      expect(parsed.error?.issues ?? []).toEqual([]);
      expect(parsed.success).toBe(true);
    },
  );

  it('REGRESSION — the input contract rejects a reviewer-minted challengeId', () => {
    // Identity is host-owned; the reviewer-facing contract must not even model it.
    const challenge = reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF]);
    const parsed = ReviewerChallengeInput.safeParse({
      ...challenge,
      challengeId: '99999999-9999-4999-8999-999999999999',
    });

    // Strict grammar: the foreign key is a schema violation, never silently
    // stripped into host-canonical shape.
    expect(parsed.success).toBe(false);
  });

  it('REGRESSION — the input contract accepts a pass/fail implementation outcome', () => {
    const challenge = reviewerChallengeFromPrompt('implementation_challenge', IMPLEMENTATION_REFS, {
      outcome: 'fail',
    });

    expect(ReviewerChallengeInput.safeParse(challenge).success).toBe(true);
  });
});

describe('challenge contract enforcement at binding time', () => {
  it('BAD — rejects a payload that supplies fewer challenges than the frozen count', () => {
    const result = bind(TOOL_FLOWGUARD_PLAN, obligationFor('plan', 'design_challenge', 2), []);

    expect(result.bindOutcome).toBe('challenge_contract_violation');
    expect(result.evidence).toBeNull();
    expect(result.diagnostic).toMatchObject({ required: 2, actual: 0 });
  });

  it('BAD — rejects a payload that supplies more challenges than the frozen count', () => {
    const challenges = [
      reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF]),
      reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF], {
        clientReference: 'c2',
      }),
    ];
    const result = bind(
      TOOL_FLOWGUARD_PLAN,
      obligationFor('plan', 'design_challenge', 1),
      challenges,
    );

    expect(result.bindOutcome).toBe('challenge_contract_violation');
    expect(result.diagnostic).toMatchObject({ required: 1, actual: 2 });
  });

  it('BAD — a contract violation rejects the attempt instead of consuming it', () => {
    const result = bind(TOOL_FLOWGUARD_PLAN, obligationFor('plan', 'design_challenge', 2), []);

    // `rejected` is re-armable; a `bound` attempt is not. Binding unusable
    // evidence would leave the obligation permanently unsatisfiable.
    expect(result.attempt?.status).toBe('rejected');
  });

  it('HAPPY — an obligation with no frozen challenge count still binds', () => {
    const obligation = pendingObligation({ obligationId: OBLIGATION_ID, obligationType: 'plan' });
    expect(obligation.requiredChallengeCount).toBeUndefined();

    const result = bind(TOOL_FLOWGUARD_PLAN, obligation, []);

    expect(result.bindOutcome).toBe('bound');
  });
});

describe('client reference integrity', () => {
  it('BAD — rejects duplicate clientReference values within one payload', () => {
    const challenges = [
      reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF]),
      reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF]),
    ];
    const result = bind(
      TOOL_FLOWGUARD_PLAN,
      obligationFor('plan', 'design_challenge', 2),
      challenges,
    );

    expect(result.bindOutcome).toBe('client_reference_invalid');
    expect(result.evidence).toBeNull();
    expect(result.diagnostic).toMatchObject({ clientReference: 'c1', challengeIndex: 1 });
  });

  it('HAPPY — distinct clientReference values map to distinct host identities', () => {
    const challenges = [
      reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF]),
      reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF], {
        clientReference: 'c2',
      }),
    ];
    const result = bind(
      TOOL_FLOWGUARD_PLAN,
      obligationFor('plan', 'design_challenge', 2),
      challenges,
    );
    const bound = result.evidence?.capturedRawFindings as
      { challenges?: { challengeId?: string; clientReference?: string }[] } | undefined;

    expect(result.bindOutcome).toBe('bound');
    expect(bound?.challenges?.map((c) => c.clientReference)).toEqual(['c1', 'c2']);
    expect(bound?.challenges?.[0]?.challengeId).not.toBe(bound?.challenges?.[1]?.challengeId);
  });

  it('EDGE — a challenge without a clientReference binds without inventing one', () => {
    const challenge = reviewerChallengeFromPrompt('design_challenge', [PLAN_SECTION_REF]);
    delete challenge.clientReference;

    const result = bind(TOOL_FLOWGUARD_PLAN, obligationFor('plan', 'design_challenge', 1), [
      challenge,
    ]);
    const bound = result.evidence?.capturedRawFindings as
      { challenges?: Record<string, unknown>[] } | undefined;

    expect(result.bindOutcome).toBe('bound');
    expect(bound?.challenges?.[0]).not.toHaveProperty('clientReference');
    expect(bound?.challenges?.[0]?.challengeId).toEqual(expect.any(String));
  });
});
