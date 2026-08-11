import { describe, expect, it } from 'vitest';
import { ReviewChallenge } from '../../state/evidence-review.js';
import {
  buildArchitectureReviewPrompt,
  buildImplReviewPrompt,
  buildPlanReviewPrompt,
  buildReviewContentPrompt,
  renderFrozenReviewSubjectEnvelope,
  renderReviewerTaskPrompt,
} from './prompt-builders.js';
import { renderPersistedProofGraphContext } from './proof-context.js';
import { FROZEN_REVIEW_ANCHOR_CONTRACT } from './frozen-reviewer-context.js';
import type { FrozenReviewerContext } from './frozen-reviewer-context.js';

const BASE_INPUT = {
  iteration: 0,
  planVersion: 1,
  obligationId: '11111111-1111-4111-8111-111111111111',
  mandateDigest: 'mandate-digest',
  criteriaVersion: 'criteria-v1',
  subjectLabel: 'the artifact under review',
};

describe('renderReviewerTaskPrompt challenge contract', () => {
  it('requires omitting optional challenges when the frozen count is zero', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: { requiredChallengeCount: 0, requiredChallengeKind: 'design_challenge' },
    });

    expect(prompt).toContain('requiredChallengeCount=0');
    expect(prompt).toContain('Omit the optional challenges field entirely');
  });

  it('provides only host-authoritative evidence for required challenges', () => {
    const evidenceRef = {
      kind: 'plan_adr_section',
      artifactKind: 'adr',
      artifactDigest: 'adr-digest',
      sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
      excerptDigest: 'excerpt-digest',
    };
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        evidenceRefs: [evidenceRef],
      },
    });

    expect(prompt).toContain('return exactly 1 design_challenge challenge(s)');
    expect(prompt).toContain(JSON.stringify(evidenceRef));
    // The reviewer supplies only a client-side reference; the canonical
    // challengeId is host-assigned, so the prompt must never ask for one. The
    // example must itself satisfy the clientReference format, otherwise a
    // reviewer copying the shape verbatim is rejected by the canonical schema.
    expect(prompt).toContain('"clientReference":"c1"');
    expect(prompt).not.toContain('"challengeId"');
    expect(prompt).toContain('"obligationId":"11111111-1111-4111-8111-111111111111"');
    expect(prompt).toContain('"kind":"design_challenge"');
    expect(prompt).toContain('Omit challengeResolutionVerdicts');

    const match = prompt.match(/Required challenge object shape: (.+)/);
    expect(match).not.toBeNull();
    const renderedChallenge = JSON.parse(match![1]!);
    expect(
      ReviewChallenge.safeParse({
        ...renderedChallenge,
        challengeId: '22222222-2222-4222-8222-222222222222',
        scenario: 'Challenge the reviewed decision.',
        claim: 'The decision is supported by the cited section.',
        locations: ['ADR: Decision'],
      }).success,
    ).toBe(true);
  });
});

describe('frozen review subject envelope', () => {
  const frozenReviewerContext: FrozenReviewerContext = {
    reviewMaterial: { content: 'exact persisted material', materialDigest: 'a'.repeat(64) },
    reviewSubject: {
      kind: 'content' as const,
      source: { kind: 'inline' as const, mediaType: 'text' as const },
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'b'.repeat(64),
      lineCount: 1,
    },
    reviewSubjectScope: { kind: 'content' as const, subjectDigest: 'b'.repeat(64), lineCount: 1 },
    anchorContract: FROZEN_REVIEW_ANCHOR_CONTRACT,
  };

  it('keeps exact persisted material immediately after the anchor in both transports', () => {
    const hostPrompt = renderReviewerTaskPrompt({ ...BASE_INPUT, frozenReviewerContext });
    const sdkPrompt = buildReviewContentPrompt({
      content: 'untrusted content',
      ticketText: '',
      obligationId: BASE_INPUT.obligationId,
      mandateDigest: BASE_INPUT.mandateDigest,
      criteriaVersion: BASE_INPUT.criteriaVersion,
      iteration: BASE_INPUT.iteration,
      planVersion: BASE_INPUT.planVersion,
      discoveryContext: {},
      frozenReviewerContext,
    });
    const envelope = renderFrozenReviewSubjectEnvelope(frozenReviewerContext).join('\n');
    const anchorAndMaterial =
      'Append the persisted review material below this line:\nexact persisted material';

    expect(hostPrompt).toContain(envelope);
    expect(sdkPrompt).toContain(envelope);
    expect(hostPrompt).toContain(anchorAndMaterial);
    expect(sdkPrompt).toContain(anchorAndMaterial);
    expect(sdkPrompt).not.toContain('CONTENT TO REVIEW:');
    expect(sdkPrompt).not.toContain('untrusted content');
  });
});

describe('renderPersistedProofGraphContext', () => {
  it('reports persisted coverage and critical unresolved claims without evaluating providers', () => {
    const text = renderPersistedProofGraphContext({
      version: 'proofgraph.v1',
      evaluatedAt: '2026-01-01T00:00:00.000Z',
      claims: [
        {
          claimId: '11111111-1111-4111-8111-111111111111',
          statement: 'The critical path rejects invalid input.',
          signalClass: 'fact',
          critical: true,
          provenance: null,
          evidenceRefs: [],
          counterexampleRefs: [],
          verificationState: 'NOT_VERIFIED',
        },
        {
          claimId: '22222222-2222-4222-8222-222222222222',
          statement: 'The non-critical path remains compatible.',
          signalClass: 'fact',
          critical: false,
          provenance: null,
          evidenceRefs: [],
          counterexampleRefs: [],
          verificationState: 'PROVEN',
        },
      ],
    }).join('\n');

    expect(text).toContain('Coverage: 1/2 claims PROVEN; 1 unresolved.');
    expect(text).toContain('[NOT_VERIFIED] 11111111-1111-4111-8111-111111111111');
    expect(text).toContain('not a review verdict or reviewer authority');
  });

  it('fails closed when no persisted projection is available', () => {
    expect(renderPersistedProofGraphContext(undefined).join('\n')).toContain(
      'Coverage: NOT_DECLARED',
    );
  });
});

describe('ProofGraph prompt context', () => {
  const proofGraph = {
    version: 'proofgraph.v1' as const,
    evaluatedAt: '2026-01-01T00:00:00.000Z',
    claims: [],
  };
  const common = {
    ticketText: 'ticket',
    obligationId: BASE_INPUT.obligationId,
    mandateDigest: BASE_INPUT.mandateDigest,
    criteriaVersion: BASE_INPUT.criteriaVersion,
    iteration: BASE_INPUT.iteration,
    planVersion: BASE_INPUT.planVersion,
    discoveryContext: {},
    proofGraph,
  };

  it('is included in plan, architecture, implementation, and standalone prompts', () => {
    const prompts = [
      buildPlanReviewPrompt({ ...common, planText: 'plan' }),
      buildArchitectureReviewPrompt({ ...common, adrText: 'adr', adrTitle: 'ADR-1' }),
      buildImplReviewPrompt({ ...common, planText: 'plan', changedFiles: [] }),
      buildReviewContentPrompt({ ...common, content: 'content' }),
    ];

    for (const prompt of prompts) {
      expect(prompt).toContain('## ProofGraph Context (persisted, advisory)');
      expect(prompt).toContain('Coverage: 0/0 claims PROVEN; 0 unresolved.');
    }
  });
});
