import { describe, expect, it } from 'vitest';
import { ReviewChallenge } from '../../../state/evidence-review-challenge.js';
import { IMPL_EVIDENCE, VALIDATION_PASSED, makeState } from '../../../fixtures.js';
import { renderFrozenReviewSubjectEnvelope, renderReviewerTaskPrompt } from './prompt-builders.js';
import { renderPlanClaimDeclarations } from '../../../presentation/index.js';
import { buildFrozenReviewMaterialContent } from '../context/reviewer-context.js';
import type { FrozenReviewerContext } from '../../../state/review-continuation.js';

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

    expect(prompt).toContain('Bind iteration exactly to 4.');
    expect(prompt).toContain('Bind planVersion exactly to 7.');
    expect(prompt).toContain('Bind reviewMode exactly to "subagent".');
  });

  it('requires omitting optional challenges when the frozen count is zero', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: { requiredChallengeCount: 0, requiredChallengeKind: 'design_challenge' },
    });

    expect(prompt).toContain(
      'Challenge requirement: exactly 0 challenges are required for this review.',
    );
    expect(prompt).not.toContain('Required challenge object shape');
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
    const match = prompt.match(/Required challenge object shape: (.+)/);
    expect(match).not.toBeNull();
    expect(match![1]).not.toContain('"challengeId"');
    expect(prompt).toContain('"obligationId":"11111111-1111-4111-8111-111111111111"');
    expect(prompt).toContain('"kind":"design_challenge"');
    expect(prompt).toContain('Omit challengeResolutionVerdicts');
    expect(prompt).toContain('outcome. Select it yourself');

    const renderedChallenge = JSON.parse(match![1]!);
    expect(
      ReviewChallenge.safeParse({
        ...renderedChallenge,
        challengeId: '22222222-2222-4222-8222-222222222222',
        scenario: 'Challenge the reviewed decision.',
        claim: 'The decision is supported by the cited section.',
        locations: ['ADR: Decision'],
        outcome: 'supported',
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
    // The prompt must name the canonical vocabulary without anchoring the
    // independent reviewer on one favorable default outcome.
    const match = prompt.match(/Required challenge object shape: (.+)/);
    const rendered = JSON.parse(match![1]!) as Record<string, unknown>;
    expect(rendered).not.toHaveProperty('outcome');
    expect(prompt).not.toContain('"outcome":"supported"');
    expect(prompt).not.toContain('"outcome":"pass"');
  });

  it('requires a negative verdict for unresolved challenge outcomes', () => {
    const prompt = renderReviewerTaskPrompt({ ...BASE_INPUT });

    expect(prompt).toContain(
      'A contradicted content/design challenge, or a failed/not_verified implementation challenge, is a blocking issue',
    );
  });
});

describe('unable_to_review prioritization', () => {
  const PRIORITIZATION_LINE =
    '- Before declaring unable_to_review, identify the facts your verdict depends on and resolve them through the authorized observation means actually available to this review';
  const UNABLE_LINE =
    '- unable_to_review is valid only when honest review is impossible because required context/evidence is missing, corrupt, mismatched, or unavailable AND the necessary facts could not be established through those authorized observation means.';

  it('requires resolving verdict-relevant facts through authorized observation first', () => {
    const prompt = renderReviewerTaskPrompt({ ...BASE_INPUT });

    expect(prompt).toContain(PRIORITIZATION_LINE);
    expect(prompt).toContain('the supplied Discovery context and flowguard_observe_repository');
    expect(prompt).toContain(UNABLE_LINE);
    // The prioritization rule leads; the inability clause remains the narrow
    // residual case and keeps the fail-closed semantics unchanged.
    expect(prompt.indexOf(PRIORITIZATION_LINE)).toBeGreaterThan(-1);
    expect(prompt.indexOf(PRIORITIZATION_LINE)).toBeLessThan(prompt.indexOf(UNABLE_LINE));
  });
});

describe('frozen review subject envelope', () => {
  const frozenReviewerContext: FrozenReviewerContext = {
    reviewMaterial: {
      content: 'exact persisted material',
      materialDigest: 'a'.repeat(64),
      subjectDigest: 'b'.repeat(64),
    },
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

  it('keeps exact persisted material immediately after the anchor', () => {
    const hostPrompt = renderReviewerTaskPrompt({ ...BASE_INPUT, frozenReviewerContext });
    const envelope = renderFrozenReviewSubjectEnvelope(frozenReviewerContext).join('\n');
    const anchorAndMaterial =
      'Append the persisted review material below this line:\nexact persisted material';

    expect(hostPrompt).toContain(envelope);
    expect(hostPrompt).toContain(anchorAndMaterial);
  });
});

describe('repository observation and reviewer-provenance rules', () => {
  it('forbids reviewer-authored provenance before host stamping', () => {
    const prompt = renderReviewerTaskPrompt({ ...BASE_INPUT });
    expect(prompt).toContain('Do NOT output reviewedBy or reviewedAt.');
    expect(prompt).toContain('ReviewerFindingsInput');
  });
});

describe('native implementation review execution-continuity semantics', () => {
  const OBSERVED_DIGEST = 'b'.repeat(64);
  const PRE_COMMIT_DIGEST = 'c'.repeat(64);
  const MATERIAL_ANCHOR = 'Append the persisted review material below this line:';
  const CONTINUITY_RULE = 'treat session-state continuity as NOT_VERIFIED';

  /**
   * Compose the canonical native reviewer prompt exactly like the production
   * transport: the frozen review material is the sole evidence carrier, and the
   * trusted context only carries host-owned interpretation rules.
   */
  function nativeComposition(stateChangedDuringExecution: boolean) {
    const state = makeState('IMPL_REVIEW', {
      implementation: IMPL_EVIDENCE,
      validationAttempts: [
        {
          attemptId: '22222222-2222-4222-8222-222222222222',
          scope: 'implementation',
          implementationId: '00000000-0000-4000-8000-0000000000aa',
          implementationDigest: IMPL_EVIDENCE.digest,
          executionObservation: {
            executionObservedStateDigest: OBSERVED_DIGEST,
            preCommitStateDigest: stateChangedDuringExecution ? PRE_COMMIT_DIGEST : OBSERVED_DIGEST,
          },
          result: VALIDATION_PASSED[0]!,
        },
      ] as never,
    });
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'implement',
      renderPlanClaimDeclarations,
      state,
      artifact: 'the diff under review',
    });
    const frozenReviewerContext: FrozenReviewerContext = {
      reviewMaterial: {
        content,
        materialDigest: 'd'.repeat(64),
        subjectDigest: IMPL_EVIDENCE.digest,
      },
    };
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      reviewType: 'implementation',
      frozenReviewerContext,
      proofContext: [],
    });
    const anchorIndex = prompt.indexOf(MATERIAL_ANCHOR);
    expect(anchorIndex).toBeGreaterThan(-1);
    return {
      trusted: prompt.slice(0, anchorIndex),
      frozen: prompt.slice(anchorIndex),
    };
  }

  it('carries the host-owned continuity rule in the trusted context, without duplicating evidence', () => {
    const { trusted, frozen } = nativeComposition(true);

    expect(trusted).toContain(CONTINUITY_RULE);
    expect(trusted).toContain('NOT_VERIFIED: session-state continuity changed during execution.');
    expect(trusted).toContain(
      'Do not change the executed check verdict solely because of this continuity signal.',
    );

    // Evidence (digests and the derived projection) stays exclusively in the
    // frozen material; the trusted context must not carry a second copy.
    expect(frozen).toContain(OBSERVED_DIGEST);
    expect(frozen).toContain(PRE_COMMIT_DIGEST);
    expect(trusted).not.toContain(OBSERVED_DIGEST);
    expect(trusted).not.toContain(PRE_COMMIT_DIGEST);
  });

  it('keeps an executed PASS classified as PASS under a changed continuity', () => {
    const { frozen, trusted } = nativeComposition(true);

    expect(frozen).toContain('"passed":true');
    expect(frozen).toContain('"stateChangedDuringExecution":true');
    expect(trusted).not.toContain('"passed":false');
    expect(trusted).not.toContain('reclassify');
  });

  it('keeps the rule static when continuity is unchanged', () => {
    const { trusted, frozen } = nativeComposition(false);

    expect(trusted).toContain(CONTINUITY_RULE);
    expect(frozen).toContain('"stateChangedDuringExecution":false');
  });

  it('does not inject the implementation continuity rule into non-implementation reviews', () => {
    const prompt = renderReviewerTaskPrompt({ ...BASE_INPUT, reviewType: 'content' });
    expect(prompt).not.toContain(CONTINUITY_RULE);
  });
});

describe('renderReviewerTaskPrompt plan-review verification authority (p42-v3)', () => {
  it('projects the verification authority and phase boundary into plan review only', () => {
    const plan = renderReviewerTaskPrompt({ ...BASE_INPUT, reviewType: 'plan' });
    expect(plan).toContain(
      'Verification authority: Assess checks against the persisted verification candidates supplied to this review',
    );
    expect(plan).toContain(
      'The executable command is the selected candidate command; repository script bodies describe its implementation but do not replace that command.',
    );
    expect(plan).toContain('treat that authority as NOT_VERIFIED rather than assuming it');
    expect(plan).toContain(
      'Verification phase: plan review precedes baseline and implementation validation.',
    );
    expect(plan).toContain(
      'Do not require results of future validation as already-existing evidence',
    );
    expect(plan).not.toContain('sourced from repo scripts/contracts');

    const implementation = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      reviewType: 'implementation',
    });
    expect(implementation).not.toContain('Verification phase: plan review precedes');
  });
});

describe('renderReviewerTaskPrompt output boundary', () => {
  it('requires prose-complete conclusions and forbids a serialized JSON duplicate', () => {
    const prompt = renderReviewerTaskPrompt(BASE_INPUT);
    expect(prompt).toContain('### Output Boundary');
    expect(prompt).toContain('Do NOT emit a serialized ReviewerFindingsInput');
    expect(prompt).toContain('serialization must be derivable from it without inventing or');
  });

  it('asks for compact prose that cites refs by number and locations by path:line (p42-v7)', () => {
    const prompt = renderReviewerTaskPrompt(BASE_INPUT);
    expect(prompt).toContain(
      'Write the review as compact, complete prose: lead with the overall verdict; then, for each',
    );
    expect(prompt).toContain('subject (the offered Ref number, or the anchor the anchor');
    expect(prompt).toContain(
      'evidence locations as path:line (with the revision when more than one is',
    );
    expect(prompt).toContain(
      'Never restate digests, section paths, attempt IDs, or evidence objects: Ref numbers and',
    );
    expect(prompt).not.toContain('Report EVERY finding, relation, evidence location');
  });

  it('settles assessed points without forbidding a reopen on new evidence', () => {
    const rule =
      '- Once a review point has been assessed against the available evidence, record the conclusion ' +
      'and proceed. Do not repeatedly reconsider the same point without new relevant evidence, a ' +
      'concrete contradiction, or an unresolved requirement. Reopen a conclusion whenever such ' +
      'evidence emerges. Never suppress findings or shorten required falsification checks merely to ' +
      'finish the review.';
    for (const reviewType of ['plan', 'adr', 'implementation', 'content', 'all'] as const) {
      const lines = renderReviewerTaskPrompt({ ...BASE_INPUT, reviewType }).split('\n');
      const falsify = lines.indexOf(
        '- Falsify before accepting. Ground findings in concrete evidence; never fabricate convergence.',
      );
      expect(falsify).toBeGreaterThan(-1);
      // A working instruction directly under the falsification rule, stated once.
      expect(lines[falsify + 1]).toBe(rule);
      expect(lines.filter((line) => line === rule)).toHaveLength(1);
    }
  });

  it('renders every offered ref object once and keeps the output contract bounded', () => {
    const refs = Array.from({ length: 11 }, (_, index) => ({
      kind: 'plan_adr_section',
      artifactKind: 'plan',
      artifactDigest: 'a'.repeat(64),
      sectionPath: [{ headingDepth: 2, siblingIndex: index + 1, headingText: `Section ${index}` }],
      excerptDigest: String(index % 10).repeat(64),
    }));
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      challengeContract: {
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        evidenceRefs: refs,
      },
    });
    refs.forEach((ref, index) => {
      // Listed once as Ref N; only the shape example repeats the first ref.
      expect(prompt.split(JSON.stringify(ref)).length - 1).toBe(index === 0 ? 2 : 1);
      expect(prompt).toContain(`  Ref ${index + 1}: ${JSON.stringify(ref)}`);
    });
    const boundary = prompt.slice(
      prompt.indexOf('### Output Boundary'),
      prompt.indexOf('## Trusted Runtime Context'),
    );
    expect(boundary.length).toBeLessThanOrEqual(OUTPUT_BOUNDARY_BUDGET);
  });
});

/** Growth guard for the prose contract; raise only with a deliberate contract change. */
const OUTPUT_BOUNDARY_BUDGET = 1_200;

describe('renderReviewerTaskPrompt plan evidence roles and blocking bar (p42-v4)', () => {
  const ROLE_RULE =
    "- Evidence roles: a claim's positive evidence comes from executions of its positive evidence check and its counterexample evidence from separate executions of its counterexample check, each with its own attempt identity. Different checks may run overlapping test suites; that overlap is allowed and is not a defect. Plan review does not require these executions to exist yet.";
  const BLOCKING_BAR =
    'Every blocking issue must let the author act: name the unmet ticket requirement or the concrete plan defect, the exact plan section, the supplied evidence (frozen material, verification candidate, or observed repository bytes) that demonstrates it, and a feasible minimal repair. A fact you could not establish from that evidence is NOT_VERIFIED, not a demonstrated defect. Never fabricate findings: a plan that satisfies the ticket and these criteria is accepted without extra review rounds.';

  function claim(index: number) {
    return {
      claimId: `1111111${index}-1111-4111-8111-111111111111`,
      statement: `Claim ${index} rejects writes without ownership.`,
      critical: true,
      authoritySectionId: 'Invariant',
      claimScope: 'specific_behavior' as const,
      expectedCheckId: 'test',
      counterexampleRequirement: {
        kind: 'assertion' as const,
        checkId: 'build',
        assertion: { providerId: 'junit', localId: `fixture.ProbeTest#rejects${index}` },
      },
    };
  }

  function occurrences(text: string, needle: string): number {
    return text.split(needle).length - 1;
  }

  it('states the role rule once although claims appear in advisory context and frozen material', () => {
    const declarations = { flow: 'plan', version: 'v2', claims: [claim(1), claim(2)] } as never;
    const claims = renderPlanClaimDeclarations(declarations);
    const content = buildFrozenReviewMaterialContent({
      obligationType: 'plan',
      renderPlanClaimDeclarations,
      state: makeState('PLAN_REVIEW'),
      artifact: '# Plan\n\nBody.',
      planClaimDeclarations: declarations,
    });
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      reviewType: 'plan',
      proofContext: ['### Plan claim declarations (2)', claims],
      frozenReviewerContext: {
        reviewMaterial: {
          content,
          materialDigest: 'd'.repeat(64),
          subjectDigest: 'e'.repeat(64),
        },
      },
    });

    expect(occurrences(prompt, 'Positive evidence check: test')).toBe(4);
    expect(occurrences(prompt, ROLE_RULE)).toBe(1);
    expect(occurrences(prompt, 'Evidence roles')).toBe(1);
    expect(prompt).not.toContain('do not imply that both evidence roles share an attempt');
  });

  it('carries the plan blocking bar in plan review only', () => {
    const plan = renderReviewerTaskPrompt({ ...BASE_INPUT, reviewType: 'plan' });
    expect(occurrences(plan, BLOCKING_BAR)).toBe(1);

    for (const reviewType of ['implementation', 'adr', 'content'] as const) {
      const other = renderReviewerTaskPrompt({ ...BASE_INPUT, reviewType });
      expect(other, reviewType).not.toContain(BLOCKING_BAR);
      expect(other, reviewType).not.toContain(ROLE_RULE);
    }
  });
});

describe('reviewer context dossier experiment', () => {
  const snapshot = {
    observedAt: '2026-01-01T00:00:00.000Z',
    discoveryDigest: 'discovery-digest',
    workspaceFingerprint: 'workspace',
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
      currentDigest: 'current',
      persistedDigest: 'persisted',
      changedContributorNames: [],
      notVerified: [],
    },
    detectedStack: null,
    verificationCandidates: [],
    riskSurfaces: [],
    warnings: [],
    notVerified: [],
  } as never;

  it('keeps the baseline context unchanged when the dossier arm is not selected', () => {
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      repositoryReview: true,
      proofContext: ['BASELINE-PROOF-MARKER'],
      repositoryDiscoverySnapshot: snapshot,
    });
    expect(prompt).toContain('BASELINE-PROOF-MARKER');
    expect(prompt).toContain('## Repository Discovery Context (advisory, host-observed)');
    expect(prompt).not.toContain('## Evidence Dossier');
  });

  it('replaces redundant derived blocks with one untrusted dossier before the frozen marker', () => {
    const dossier = '## Evidence Dossier (derived, advisory, untrusted)\n\nDOSSIER-MARKER';
    const prompt = renderReviewerTaskPrompt({
      ...BASE_INPUT,
      contextMode: 'dossier',
      evidenceDossier: dossier,
      repositoryReview: true,
      proofContext: ['BASELINE-PROOF-MARKER'],
      repositoryDiscoverySnapshot: snapshot,
    });
    expect(prompt).not.toContain('BASELINE-PROOF-MARKER');
    expect(prompt).not.toContain('## Repository Discovery Context (advisory, host-observed)');
    expect(prompt).toContain('DOSSIER-MARKER');
    expect(prompt.indexOf('## Frozen Untrusted Subject')).toBeLessThan(
      prompt.indexOf('DOSSIER-MARKER'),
    );
    expect(prompt.indexOf('DOSSIER-MARKER')).toBeLessThan(prompt.indexOf('below this line:'));
  });
});
