/**
 * Structural preflight contracts: evidence design, finding responses, claim lineage.
 * These tests prove declaration completeness only, never semantic sufficiency.
 */
import { describe, expect, it } from 'vitest';
import {
  mintProofGraphClaimId,
  type PlanClaimDeclaration,
} from '../../../state/proofgraph-approval.js';
import type { ReviewFindings } from '../../../state/evidence.js';
import type { VerificationCandidate } from '../../../state/discovery-schemas.js';
import { extractFencedBlock } from './plan-fenced-block.js';
import { runPlanPreflight } from './plan-preflight.js';

const witness = {
  providerId: 'junit',
  localId: 'com.example.SessionTest#rejectInvalidState',
} as const;

function claim(
  statement: string,
  overrides: Partial<PlanClaimDeclaration> = {},
): PlanClaimDeclaration {
  const authoritySectionId = overrides.authoritySectionId ?? 'implementation-step-1';
  return {
    claimId: mintProofGraphClaimId({ domain: 'plan', authoritySectionId, statement }),
    statement,
    critical: true,
    claimScope: 'specific_behavior',
    authoritySectionId,
    expectedCheckId: 'test',
    counterexampleRequirement: {
      kind: 'assertion',
      checkId: 'build',
      assertion: witness,
    },
    ...overrides,
  };
}

const candidate = (kind: string, candidateId: string): VerificationCandidate =>
  ({
    candidateId,
    kind,
    command: `npm run ${kind}`,
    source: 'package.json',
    confidence: 'high',
    reason: 'fixture',
    assertionCapability: 'structured',
    assertionReport: { providerId: 'junit', transport: 'stdout', format: 'junit-xml' },
  }) as VerificationCandidate;

const candidates = [candidate('test', 'vc-test'), candidate('build', 'vc-build')];

function designMany(
  claims: readonly { readonly statement: string; readonly authoritySectionId: string }[],
  patch: Record<string, string> = {},
): string {
  return [
    '```flowguard-evidence-design',
    JSON.stringify({
      version: 1,
      claims: claims.map((claim) => ({
        authoritySectionId: claim.authoritySectionId,
        statement: claim.statement,
        positiveObservable: 'the positive test observes rejection',
        faultyVariant: 'remove the validation that rejects invalid state',
        expectedFailure: 'the bound assertion fails',
        executionRoute: 'vc-build',
        ...patch,
      })),
    }),
    '```',
  ].join('\n');
}

function design(statement: string, patch: Record<string, string> = {}): string {
  return designMany([{ statement, authoritySectionId: 'implementation-step-1' }], patch);
}

function finding(id: string | undefined): ReviewFindings['blockingIssues'][number] {
  const location = { path: 'src/foo.ts', revision: 'head' as const };
  return {
    ...(id === undefined ? {} : { findingId: id }),
    severity: 'critical',
    category: 'correctness',
    message: 'missing evidence',
    relation: {
      subjectAnchors: [{ kind: 'repository_location', location }],
      evidenceLocations: [],
    },
  };
}

function planWithVerification(statement: string): string {
  return `${design(statement)}\n\n## Verification\n- Evidence is named here.`;
}

function findingLedger(
  resolutions: readonly unknown[],
  patch: Record<string, unknown> = {},
): string {
  return [
    '```flowguard-finding-resolutions',
    JSON.stringify({
      version: 1,
      reviewObligationId: obligation.obligationId,
      reviewIteration: obligation.iteration,
      planVersion: obligation.planVersion,
      resolutions,
      ...patch,
    }),
    '```',
  ].join('\n');
}

function claimLedger(changes: readonly unknown[]): string {
  return [
    '```flowguard-claim-changes',
    JSON.stringify({ version: 1, claimChanges: changes }),
    '```',
  ].join('\n');
}

const obligation = {
  obligationId: '11111111-1111-4111-8111-111111111111',
  iteration: 0,
  planVersion: 1,
};

describe('plan preflight evidence design', () => {
  it('accepts a complete design for every critical claim', () => {
    const critical = claim('Invalid state is rejected.');
    expect(
      runPlanPreflight({
        planText: design(critical.statement),
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('requires a design block when a critical claim exists', () => {
    const critical = claim('Invalid state is rejected.');
    const result = runPlanPreflight({
      planText: '# Plan',
      currentClaims: [critical],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_EVIDENCE_DESIGN_REQUIRED');
  });

  it('accepts a noncritical plan without a design block', () => {
    const noncritical = claim('Noncritical behavior.', { critical: false });
    expect(
      runPlanPreflight({
        planText: '# Plan',
        currentClaims: [noncritical],
        priorClaims: [],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('rejects duplicate, unclosed, malformed and schema-invalid blocks', () => {
    const critical = claim('Invalid state is rejected.');
    const valid = design(critical.statement);
    const cases = [
      `${valid}\n${valid}`,
      '```flowguard-evidence-design\n{"version":1',
      '```flowguard-evidence-design\nnot-json\n```',
      '```flowguard-evidence-design\n{"version":1,"claims":[{"authoritySectionId":"implementation-step-1","statement":"Invalid state is rejected.","positiveObservable":"x","faultyVariant":"y","executionRoute":"vc-build"}]}\n```',
    ];
    for (const planText of cases) {
      const result = runPlanPreflight({
        planText,
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects placeholders and a route that does not name the active candidate', () => {
    const critical = claim('Invalid state is rejected.');
    for (const patch of [
      { faultyVariant: 'TBD' },
      { executionRoute: 'some other check' },
      { executionRoute: 'unverified-vc-build-backup' },
    ]) {
      const result = runPlanPreflight({
        planText: design(critical.statement, patch),
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });
});

describe('plan preflight claim lineage', () => {
  const prior = claim('Invalid state is rejected.');

  it('accepts an unchanged retained critical claim without a ledger', () => {
    expect(
      runPlanPreflight({
        planText: design(prior.statement),
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('forbids a same-identity critical downgrade', () => {
    const downgraded = { ...prior, critical: false };
    const result = runPlanPreflight({
      planText: design(prior.statement),
      currentClaims: [downgraded],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked')
      expect(result.code).toBe('PLAN_CRITICAL_CLAIM_DOWNGRADE_FORBIDDEN');
  });

  it('requires a withdrawal declaration when a prior critical claim disappears', () => {
    const result = runPlanPreflight({
      planText: '# Plan',
      currentClaims: [],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_CLAIM_LINEAGE_REQUIRED');
  });

  it('supports one-to-many critical replacement', () => {
    const first = claim('Invalid identifiers are rejected.', {
      authoritySectionId: 'implementation-step-2',
    });
    const second = claim('Missing identifiers return not found.', {
      authoritySectionId: 'implementation-step-2',
    });
    const block = [
      '```flowguard-claim-changes',
      JSON.stringify({
        version: 1,
        claimChanges: [
          {
            priorClaimId: prior.claimId,
            disposition: 'replaced',
            replacementClaims: [
              { authoritySectionId: first.authoritySectionId, statement: first.statement },
              { authoritySectionId: second.authoritySectionId, statement: second.statement },
            ],
            rationale: 'split into two precise critical claims',
          },
        ],
      }),
      '```',
    ].join('\n');
    const planText = `${designMany([first, second])}\n${block}`;
    const result = runPlanPreflight({
      planText,
      currentClaims: [first, second],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('rejects a replaced declaration when the prior identity still exists', () => {
    const block = [
      '```flowguard-claim-changes',
      JSON.stringify({
        version: 1,
        claimChanges: [
          {
            priorClaimId: prior.claimId,
            disposition: 'replaced',
            replacementClaims: [
              { authoritySectionId: prior.authoritySectionId, statement: prior.statement },
            ],
            rationale: 'contradictory declaration',
          },
        ],
      }),
      '```',
    ].join('\n');
    const result = runPlanPreflight({
      planText: `${design(prior.statement)}\n${block}`,
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_CLAIM_LINEAGE_INVALID');
  });

  it('accepts a withdrawn claim with rationale', () => {
    const block = [
      '```flowguard-claim-changes',
      JSON.stringify({
        version: 1,
        claimChanges: [
          { priorClaimId: prior.claimId, disposition: 'withdrawn', rationale: 'ticket withdrawn' },
        ],
      }),
      '```',
    ].join('\n');
    expect(
      runPlanPreflight({
        planText: `# Plan\n\n${block}`,
        currentClaims: [],
        priorClaims: [prior],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });
});

describe('plan preflight finding responses', () => {
  const prior = claim('Invalid state is rejected.');
  const findingId = '33333333-3333-4333-8333-333333333333';

  it('requires a response for every bound blocking finding', () => {
    const result = runPlanPreflight({
      planText: design(prior.statement),
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
      priorBlockingFindings: [finding(findingId)],
      reviewObligation: obligation,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_FINDING_RESOLUTION_REQUIRED');
  });

  it('accepts a reasoned clarification without requiring a text change', () => {
    const block = [
      '```flowguard-finding-resolutions',
      JSON.stringify({
        version: 1,
        reviewObligationId: obligation.obligationId,
        reviewIteration: obligation.iteration,
        planVersion: obligation.planVersion,
        resolutions: [
          {
            findingId,
            planSection: '## Verification',
            response: 'The existing section already names the exact assertion; no edit is needed.',
          },
        ],
      }),
      '```',
    ].join('\n');
    expect(
      runPlanPreflight({
        planText: `${planWithVerification(prior.statement)}\n${block}`,
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
        priorBlockingFindings: [finding(findingId)],
        reviewObligation: obligation,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('rejects a ledger bound to the new plan version instead of the review obligation', () => {
    const block = [
      '```flowguard-finding-resolutions',
      JSON.stringify({
        version: 1,
        reviewObligationId: obligation.obligationId,
        reviewIteration: obligation.iteration,
        planVersion: 2,
        resolutions: [{ findingId, planSection: '## Verification', response: 'addressed' }],
      }),
      '```',
    ].join('\n');
    const result = runPlanPreflight({
      planText: `${planWithVerification(prior.statement)}\n${block}`,
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
      priorBlockingFindings: [finding(findingId)],
      reviewObligation: obligation,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_FINDING_RESOLUTION_INVALID');
  });

  it('rejects whitespace-only responses and unverified plan sections', () => {
    for (const resolution of [
      { findingId, planSection: '## Verification', response: '   ' },
      { findingId, planSection: '## Missing', response: 'addressed' },
    ]) {
      const block = [
        '```flowguard-finding-resolutions',
        JSON.stringify({
          version: 1,
          reviewObligationId: obligation.obligationId,
          reviewIteration: obligation.iteration,
          planVersion: obligation.planVersion,
          resolutions: [resolution],
        }),
        '```',
      ].join('\n');
      const result = runPlanPreflight({
        planText: `${planWithVerification(prior.statement)}\n${block}`,
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
        priorBlockingFindings: [finding(findingId)],
        reviewObligation: obligation,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('fails closed when a bound finding has no host identity', () => {
    const result = runPlanPreflight({
      planText: planWithVerification(prior.statement),
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
      priorBlockingFindings: [finding(undefined)],
      reviewObligation: obligation,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_REVIEW_FEEDBACK_UNAVAILABLE');
  });
});

describe('closure edge cases', () => {
  const prior = claim('Invalid state is rejected.');
  const findingId = '33333333-3333-4333-8333-333333333333';
  const secondFindingId = '44444444-4444-4444-8444-444444444444';

  it('accepts no prior blocking findings without a ledger', () => {
    expect(
      runPlanPreflight({
        planText: planWithVerification(prior.statement),
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
        priorBlockingFindings: [],
        reviewObligation: obligation,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('rejects an unknown finding identity', () => {
    const result = runPlanPreflight({
      planText: `${planWithVerification(prior.statement)}\n${findingLedger([
        { findingId: secondFindingId, planSection: '## Verification', response: 'addressed' },
      ])}`,
      currentClaims: [prior],
      priorClaims: [prior],
      verificationCandidates: candidates,
      priorBlockingFindings: [finding(findingId)],
      reviewObligation: obligation,
    });
    expect(result.kind).toBe('blocked');
    if (result.kind === 'blocked') expect(result.code).toBe('PLAN_FINDING_RESOLUTION_INVALID');
  });

  it('rejects duplicate and incomplete finding coverage', () => {
    for (const resolutions of [
      [
        { findingId, planSection: '## Verification', response: 'one' },
        { findingId, planSection: '## Verification', response: 'two' },
      ],
      [{ findingId, planSection: '## Verification', response: 'only one' }],
    ]) {
      const result = runPlanPreflight({
        planText: `${planWithVerification(prior.statement)}\n${findingLedger(resolutions)}`,
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
        priorBlockingFindings: [finding(findingId), finding(secondFindingId)],
        reviewObligation: obligation,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects a stale obligation or iteration binding', () => {
    for (const patch of [
      { reviewObligationId: '99999999-9999-4999-8999-999999999999' },
      { reviewIteration: 7 },
    ]) {
      const result = runPlanPreflight({
        planText: `${planWithVerification(prior.statement)}\n${findingLedger(
          [{ findingId, planSection: '## Verification', response: 'addressed' }],
          patch,
        )}`,
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
        priorBlockingFindings: [finding(findingId)],
        reviewObligation: obligation,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects duplicate and unknown claim changes', () => {
    for (const changes of [
      [
        { priorClaimId: prior.claimId, disposition: 'retained' },
        { priorClaimId: prior.claimId, disposition: 'retained' },
      ],
      [{ priorClaimId: '99999999-9999-4999-8999-999999999999', disposition: 'retained' }],
    ]) {
      const result = runPlanPreflight({
        planText: `${planWithVerification(prior.statement)}\n${claimLedger(changes)}`,
        currentClaims: [prior],
        priorClaims: [prior],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects contradictory retained, withdrawn and replacement declarations', () => {
    const replacement = claim('Replacement behavior.', { critical: false });
    for (const scenario of [
      {
        current: [] as PlanClaimDeclaration[],
        changes: [{ priorClaimId: prior.claimId, disposition: 'retained' }],
      },
      {
        current: [prior],
        changes: [
          {
            priorClaimId: prior.claimId,
            disposition: 'withdrawn',
            rationale: 'not required',
          },
        ],
      },
      {
        current: [replacement],
        changes: [
          {
            priorClaimId: prior.claimId,
            disposition: 'replaced',
            replacementClaims: [
              {
                authoritySectionId: replacement.authoritySectionId,
                statement: replacement.statement,
              },
            ],
            rationale: 'replacement is not critical',
          },
        ],
      },
    ]) {
      const designText = scenario.current.some((item) => item.critical)
        ? design(scenario.current[0]!.statement)
        : '# Plan';
      const result = runPlanPreflight({
        planText: `${designText}\n${claimLedger(scenario.changes)}`,
        currentClaims: scenario.current,
        priorClaims: [prior],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });
});

describe('fenced block extraction', () => {
  it('supports tilde fences and closing fences longer than the opening fence', () => {
    expect(extractFencedBlock('~~~target\ncontent\n~~~~~', 'target')).toEqual({
      kind: 'ok',
      content: 'content',
    });
  });

  it('ignores other languages and closing fences with trailing info', () => {
    const plan = [
      '```other',
      'ignored',
      '```',
      '```target',
      'content',
      '``` not-a-close',
      'more',
      '```',
    ].join('\n');
    expect(extractFencedBlock(plan, 'target')).toEqual({
      kind: 'ok',
      content: 'content\n``` not-a-close\nmore',
    });
  });

  it('trims fence info and block content', () => {
    expect(extractFencedBlock('``` target\n  content  \n```', 'target')).toEqual({
      kind: 'ok',
      content: 'content',
    });
  });

  it('reports missing, duplicate and unclosed target blocks', () => {
    expect(extractFencedBlock('no block', 'target')).toEqual({ kind: 'missing' });
    expect(extractFencedBlock('```target\na\n```\n```target\nb\n```', 'target')).toEqual({
      kind: 'duplicate',
    });
    expect(extractFencedBlock('```target\na', 'target')).toEqual({ kind: 'unclosed' });
  });
});

describe('evidence design edge cases', () => {
  const critical = claim('Invalid state is rejected.');

  it('rejects whitespace-only fields, duplicate entries and unmatched claims', () => {
    for (const planText of [
      design(critical.statement, { faultyVariant: '   ' }),
      `${design(critical.statement)}\n${design(critical.statement)}`,
      design(critical.statement).replaceAll(
        '"authoritySectionId":"implementation-step-1"',
        '"authoritySectionId":"other-step"',
      ),
    ]) {
      const result = runPlanPreflight({
        planText,
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
      if (result.kind === 'blocked') expect(result.diagnostics.length).toBeGreaterThan(0);
    }
  });

  it('does not require an entry for a noncritical claim', () => {
    const noncritical = claim('Noncritical behavior.', { critical: false });
    expect(
      runPlanPreflight({
        planText: design(critical.statement),
        currentClaims: [critical, noncritical],
        priorClaims: [],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });

  it('accepts a complete noncritical entry', () => {
    const noncritical = claim('Noncritical behavior.', { critical: false });
    expect(
      runPlanPreflight({
        planText: design(noncritical.statement),
        currentClaims: [noncritical],
        priorClaims: [],
        verificationCandidates: candidates,
      }),
    ).toEqual({ kind: 'ok' });
  });
});

describe('additional structural edge cases', () => {
  const critical = claim('Invalid state is rejected.');
  const findingId = '33333333-3333-4333-8333-333333333333';

  it('rejects duplicate entries within one design block and unmatched extra entries', () => {
    const duplicate = [
      '```flowguard-evidence-design',
      JSON.stringify({
        version: 1,
        claims: [
          JSON.parse(design(critical.statement).split('\n')[1]!).claims[0],
          JSON.parse(design(critical.statement).split('\n')[1]!).claims[0],
        ],
      }),
      '```',
    ].join('\n');
    const extra = [
      '```flowguard-evidence-design',
      JSON.stringify({
        version: 1,
        claims: [
          JSON.parse(design(critical.statement).split('\n')[1]!).claims[0],
          {
            authoritySectionId: 'other-step',
            statement: 'Unmatched claim.',
            positiveObservable: 'x',
            faultyVariant: 'y',
            expectedFailure: 'z',
            executionRoute: 'vc-build',
          },
        ],
      }),
      '```',
    ].join('\n');
    for (const planText of [duplicate, extra]) {
      const result = runPlanPreflight({
        planText,
        currentClaims: [critical],
        priorClaims: [],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects a critical claim without a counterexample or active candidate', () => {
    const withoutRequirement = { ...critical, counterexampleRequirement: undefined };
    const missingCandidate = {
      ...critical,
      counterexampleRequirement: { ...critical.counterexampleRequirement!, checkId: 'security' },
    };
    for (const current of [withoutRequirement, missingCandidate]) {
      const result = runPlanPreflight({
        planText: design(critical.statement),
        currentClaims: [current],
        priorClaims: [],
        verificationCandidates: candidates,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects malformed finding and claim blocks', () => {
    for (const planText of [
      `${planWithVerification(critical.statement)}\n\`\`\`flowguard-finding-resolutions\nnot-json\n\`\`\``,
      `${planWithVerification(critical.statement)}\n\`\`\`flowguard-claim-changes\nnot-json\n\`\`\``,
    ]) {
      const result = runPlanPreflight({
        planText,
        currentClaims: [critical],
        priorClaims: [critical],
        verificationCandidates: candidates,
        priorBlockingFindings: [finding(findingId)],
        reviewObligation: obligation,
      });
      expect(result.kind).toBe('blocked');
    }
  });

  it('rejects missing coverage and noncritical prior claim changes', () => {
    const noncriticalPrior = { ...critical, critical: false };
    const missingCoverage = claimLedger([]);
    const noncriticalChange = claimLedger([
      { priorClaimId: noncriticalPrior.claimId, disposition: 'retained' },
    ]);
    const missing = runPlanPreflight({
      planText: `# Plan\n${missingCoverage}`,
      currentClaims: [],
      priorClaims: [critical],
      verificationCandidates: candidates,
    });
    expect(missing.kind).toBe('blocked');

    const noncritical = runPlanPreflight({
      planText: `${design(critical.statement)}\n${noncriticalChange}`,
      currentClaims: [critical],
      priorClaims: [critical, noncriticalPrior],
      verificationCandidates: candidates,
    });
    expect(noncritical.kind).toBe('blocked');
  });

  it('rejects a closing fence with a different marker or shorter length', () => {
    expect(extractFencedBlock('```target\ncontent\n~~~', 'target')).toEqual({ kind: 'unclosed' });
    expect(extractFencedBlock('````target\ncontent\n```', 'target')).toEqual({ kind: 'unclosed' });
    expect(extractFencedBlock('~~~other\nignored\n~~~', 'target')).toEqual({ kind: 'missing' });
  });
});

describe('evidence design branch coverage', () => {
  it('accepts surrounding whitespace around an exact candidate id', () => {
    const critical = claim('Invalid state is rejected.');
    const result = runPlanPreflight({
      planText: design(critical.statement, { executionRoute: '  vc-build  ' }),
      currentClaims: [critical],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('does not apply counterexample checks to a noncritical claim without a requirement', () => {
    const noncritical = claim('Noncritical behavior.', {
      critical: false,
      counterexampleRequirement: undefined,
    });
    const result = runPlanPreflight({
      planText: design(noncritical.statement, { executionRoute: 'not-a-candidate' }),
      currentClaims: [noncritical],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(result).toEqual({ kind: 'ok' });
  });

  it('rejects a block that omits one of two critical claims', () => {
    const first = claim('First behavior.');
    const second = claim('Second behavior.', { authoritySectionId: 'implementation-step-2' });
    const result = runPlanPreflight({
      planText: designMany([first]),
      currentClaims: [first, second],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
  });

  it('bounds schema diagnostics to eight entries', () => {
    const claims = Array.from({ length: 12 }, (_, index) => ({
      authoritySectionId: `step-${index}`,
      statement: `Claim ${index}`,
      positiveObservable: 'x',
      faultyVariant: 'y',
      expectedFailure: 'z',
      executionRoute: 'vc-build',
    }));
    const planText = [
      '```flowguard-evidence-design',
      JSON.stringify({ version: 1, claims }),
      '```',
    ].join('\n');
    const result = runPlanPreflight({
      planText,
      currentClaims: [claim('Invalid state is rejected.')],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(result.kind).toBe('blocked');
    // Unmatched entries produce diagnostics; the schema-slice branch is
    // exercised separately by malformed objects below.
    const malformed = runPlanPreflight({
      planText: [
        '```flowguard-evidence-design',
        JSON.stringify({ version: 1, claims: [{}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}, {}] }),
        '```',
      ].join('\n'),
      currentClaims: [],
      priorClaims: [],
      verificationCandidates: candidates,
    });
    expect(malformed.kind).toBe('blocked');
    if (malformed.kind === 'blocked') expect(malformed.diagnostics).toHaveLength(8);
  });
});
