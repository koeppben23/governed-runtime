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
  it('publishes the exact top-level required field values (iteration/planVersion/reviewMode)', () => {
    // P3 contract completeness: the canonical ReviewFindings schema demands
    // top-level iteration/planVersion/reviewMode; the output contract must
    // state them with the exact dynamic values so the reviewer never has to
    // infer them from surrounding context text.
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      iteration: 4,
      planVersion: 7,
    });

    expect(prompt).toContain('iteration: 4');
    expect(prompt).toContain('planVersion: 7');
    expect(prompt).toContain('reviewMode: "subagent"');
  });

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

  /**
   * Regression: a reviewer that sees only one example outcome has to guess the
   * rest of the enum, and a wrong guess is rejected at binding time as
   * `schema_invalid` — after the reviewer already ran.
   */
  it.each([
    ['content_challenge', ['supported', 'contradicted', 'not_verified']],
    ['design_challenge', ['supported', 'contradicted', 'not_verified']],
    ['implementation_challenge', ['pass', 'fail', 'not_verified']],
  ] as const)('states the complete allowed outcome vocabulary for %s', (kind, allowed) => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: kind,
        evidenceRefs: [{ kind: 'content', digest: 'a'.repeat(64) }],
      },
    });

    const line = prompt
      .split('\n')
      .find((candidate) => candidate.startsWith(`- Allowed ${kind} outcome values`));
    expect(line, `prompt must declare the ${kind} outcome vocabulary`).toBeDefined();
    for (const value of allowed) {
      expect(line).toContain(`"${value}"`);
    }
    // The vocabulary is derived from the canonical schema, so the example value
    // the prompt shows must itself be part of the declared set.
    const match = prompt.match(/Required challenge object shape: (.+)/);
    const rendered = JSON.parse(match![1]!) as { outcome: string };
    expect(allowed).toContain(rendered.outcome);
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
    anchorContract: {
      kind: 'content' as const,
      requiredSubjectDigest: 'b'.repeat(64),
      contractText:
        'Content review: subjectAnchors must use kind=content with the exact frozen subjectDigest.',
    },
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
