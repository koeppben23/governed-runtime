/**
 * @module integration/review/dispatch/obligation-findings-schema.test
 * @description Parity of the obligation-bound structured-output schema with the
 * production capture chain.
 *
 * The same-child follow-up sends `buildObligationFindingsJsonSchema`; the host
 * validates the reviewer's JSON against it and may correct it in the same child.
 * The schema must therefore:
 * 1. never reject an answer the production chain accepts
 *    (raw -> prepareReviewerFindingsForValidation -> validateCapturedFindings);
 * 2. always be a subset of the static `REVIEW_FINDINGS_JSON_SCHEMA`;
 * 3. reject exactly the exact-equality violations the gate would reject later
 *    (attestation identity, iteration, planVersion, challenge kind, refs that
 *    were not offered, including digest/section cross-combinations).
 *
 * Validation uses a real JSON Schema validator (ajv), not string inspection.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE
 */

import { Ajv } from 'ajv';
import { describe, expect, it } from 'vitest';
import { makeState } from '../../../fixtures.js';
import { renderPlanClaimDeclarations } from '../../../presentation/index.js';
import { TEST_EXECUTION_OBSERVATION } from '../../../state/evidence-test-constants.js';
import type { ReviewObligation } from '../../../state/evidence.js';
import type { SessionState } from '../../../state/schema.js';
import {
  REVIEW_FINDINGS_JSON_SCHEMA,
  buildObligationFindingsJsonSchema,
} from '../evidence/findings-schema.js';
import { prepareReviewerFindingsForValidation } from '../enforcement/prepare-findings.js';
import { validateChallengeConsistency } from '../enforcement/challenge-consistency.js';
import { buildFrozenArtifactReviewMaterial } from '../context/reviewer-context.js';
import { artifactReviewSubjectScopeFromSections } from '../context/subject-scope.js';
import { createReviewObligation, freezeReviewMaterial } from '../obligations/assurance.js';
import {
  obligationCaptureContract,
  refsAddedAfterDispatch,
  validateCapturedFindings,
} from './native-task-review-bindings.js';

const NOW = '2026-10-20T00:00:00.000Z';
const SUBJECT = 'a'.repeat(64);
const IMPL_DIGEST = 'impl-digest-parity';
const ATTEMPT_A = '11111111-aaaa-4aaa-8aaa-111111111111';
const ATTEMPT_B = '22222222-bbbb-4bbb-8bbb-222222222222';
const FOREIGN_UUID = '99999999-9999-4999-8999-999999999999';

const ajv = new Ajv({ strict: false, allErrors: true });
const staticValidate = ajv.compile(REVIEW_FINDINGS_JSON_SCHEMA as object);

interface Fixture {
  readonly name: string;
  readonly state: SessionState;
  readonly obligation: ReviewObligation;
}

function artifactFixture(kind: 'plan' | 'architecture'): Fixture {
  const state = makeState(kind === 'plan' ? 'PLAN_REVIEW' : 'ARCHITECTURE');
  const artifact =
    kind === 'plan'
      ? '# Implementation Plan\n\n## Goal\n\nG.\n\n## Approach\n\nA.\n\n## Verification\n\nV.'
      : '# ADR-1 Title\n\n## Context\n\nC.\n\n## Decision\n\nD.';
  const parts = buildFrozenArtifactReviewMaterial({
    obligationType: kind,
    state,
    artifact,
    renderPlanClaimDeclarations,
  });
  const obligation = createReviewObligation({
    obligationType: kind,
    reviewCycle: 1,
    iteration: 2,
    planVersion: 3,
    now: NOW,
    subjectDigest: SUBJECT,
    reviewMaterial: freezeReviewMaterial(parts.content, SUBJECT),
    reviewSubjectScope: artifactReviewSubjectScopeFromSections(
      kind === 'plan' ? 'plan' : 'adr',
      parts.subjectSectionPaths,
      SUBJECT,
    ),
    repositoryEvidenceFreeze: { kind: 'unavailable', reason: 'repository_unavailable' },
    changedFiles: ['src/example.ts'],
  });
  return { name: kind, state, obligation };
}

function passingAttempt(attemptId: string) {
  return {
    attemptId,
    scope: 'implementation' as const,
    implementationId: '00000000-0000-4000-8000-0000000000aa',
    implementationDigest: IMPL_DIGEST,
    executionObservation: TEST_EXECUTION_OBSERVATION,
    result: {
      checkId: 'test',
      passed: true,
      detail: 'passed',
      executedAt: NOW,
      kind: 'test' as const,
      command: 'npm test',
      exitCode: 0,
      executionMs: 1,
      outputDigest: 'a'.repeat(64),
      timedOut: false,
    },
  };
}

function implementFixture(): Fixture {
  const state = makeState('IMPL_REVIEW', {
    implementation: {
      implementationId: '00000000-0000-4000-8000-0000000000aa',
      changedFiles: ['src/example.ts'],
      domainFiles: ['src/example.ts'],
      digest: IMPL_DIGEST,
      executedAt: NOW,
    },
    validationAttempts: [passingAttempt(ATTEMPT_A), passingAttempt(ATTEMPT_B)] as never,
  });
  const obligation = createReviewObligation({
    obligationType: 'implement',
    reviewCycle: 1,
    iteration: 1,
    planVersion: 2,
    now: NOW,
    subjectDigest: IMPL_DIGEST,
    reviewMaterial: freezeReviewMaterial('frozen implementation material', IMPL_DIGEST),
    reviewSubjectScope: { kind: 'implementation', implementationDigest: IMPL_DIGEST },
    changedFiles: ['src/example.ts'],
  });
  return { name: 'implement', state, obligation };
}

function contentFixture(): Fixture {
  const obligation = createReviewObligation({
    obligationType: 'review',
    reviewCycle: null,
    iteration: 1,
    planVersion: 1,
    now: NOW,
    subjectDigest: SUBJECT,
    reviewMaterial: freezeReviewMaterial('reviewed content', SUBJECT),
    reviewSubjectScope: { kind: 'content', subjectDigest: SUBJECT, lineCount: 1 },
    changedFiles: ['src/example.ts'],
  });
  return { name: 'review', state: makeState('PEER_REVIEW'), obligation };
}

/** HIGH-RISK variants: two required challenges of the obligation's kind. */
function withCount(fixture: Fixture, count: number): Fixture {
  return {
    name: `${fixture.name}#${count}`,
    state: fixture.state,
    obligation: { ...fixture.obligation, requiredChallengeCount: count },
  };
}

const BASE_FIXTURES = [
  artifactFixture('plan'),
  artifactFixture('architecture'),
  implementFixture(),
  contentFixture(),
];
const FIXTURES = BASE_FIXTURES.flatMap((fixture) => [
  fixture,
  withCount(fixture, 2),
  withCount(fixture, 0),
]);

function passingOutcome(kind: string): string {
  return kind === 'implementation_challenge' ? 'pass' : 'supported';
}

function failingOutcome(kind: string): string {
  return kind === 'implementation_challenge' ? 'fail' : 'contradicted';
}

function challenge(
  fixture: Fixture,
  index: number,
  evidenceRefs: readonly unknown[],
  outcome: string,
  extras: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    clientReference: `c${index}`,
    obligationId: fixture.obligation.obligationId,
    scenario: `Falsify claim ${index} through scenario ${index}.`,
    claim: `Claim ${index} holds for the frozen subject.`,
    locations: [`location ${index}`],
    kind: fixture.obligation.requiredChallengeKind,
    evidenceRefs,
    outcome,
    ...extras,
  };
}

/** Multiple anchor kinds in one relation: scope accepts it when ANY anchor fits. */
function mixedAnchorIssue(fixture: Fixture): Record<string, unknown> {
  const scope = fixture.obligation.reviewSubjectScope;
  const inScope =
    scope.kind === 'artifact'
      ? {
          kind: 'artifact_section',
          artifactKind: scope.artifact.kind,
          artifactDigest: scope.artifact.digest,
          sectionPath: scope.artifact.sectionPaths[0],
        }
      : scope.kind === 'implementation'
        ? { kind: 'implementation', implementationDigest: scope.implementationDigest }
        : { kind: 'content', subjectDigest: SUBJECT, range: { startLine: 1 } };
  return {
    severity: 'major',
    category: 'correctness',
    message: 'A concrete defect.',
    relation: {
      subjectAnchors: [
        inScope,
        { kind: 'repository_location', location: { path: 'src/example.ts', revision: 'head' } },
      ],
      evidenceLocations: [],
    },
  };
}

function findings(
  fixture: Fixture,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    iteration: fixture.obligation.iteration,
    planVersion: fixture.obligation.planVersion,
    reviewMode: 'subagent',
    overallVerdict: 'accept',
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: { toolObligationId: fixture.obligation.obligationId },
    ...overrides,
  };
}

/** Systematic candidates: verdicts, ref subsets, optional fields, edge shapes. */
function candidates(fixture: Fixture): Record<string, unknown>[] {
  const refs = obligationCaptureContract(fixture.state, fixture.obligation).allowedEvidenceRefs;
  const offered = refs ?? [{ kind: 'content', digest: SUBJECT }];
  const subsets = [[offered[0]], offered, [offered[offered.length - 1]], offered.slice(0, 2)];
  const count = fixture.obligation.requiredChallengeCount;
  const out: Record<string, unknown>[] = [];
  for (const subset of subsets) {
    const make = (outcome: string, extras: Record<string, unknown> = {}) =>
      Array.from({ length: count }, (_, i) => challenge(fixture, i + 1, subset, outcome, extras));
    const kind = String(fixture.obligation.requiredChallengeKind);
    out.push(findings(fixture, { challenges: make(passingOutcome(kind)) }));
    out.push(
      findings(fixture, {
        overallVerdict: 'changes_requested',
        blockingIssues: [mixedAnchorIssue(fixture)],
        challenges: make(failingOutcome(kind)),
      }),
    );
    out.push(
      findings(fixture, {
        challenges: make(passingOutcome(kind), { obligationId: FOREIGN_UUID }),
      }),
    );
    out.push(
      findings(fixture, {
        challenges: make(passingOutcome(kind)).map(({ clientReference: _drop, ...rest }) => rest),
        majorRisks: [mixedAnchorIssue(fixture)],
        missingVerification: ['NOT_VERIFIED: live run'],
        unknowns: ['unknown'],
      }),
    );
  }
  out.push(findings(fixture, { overallVerdict: 'unable_to_review', challenges: [] }));
  out.push(
    findings(fixture, {
      overallVerdict: 'unable_to_review',
      challenges: count > 0 ? [challenge(fixture, 1, [offered[0]], 'not_verified')] : [],
    }),
  );
  return out;
}

function gateAccepts(fixture: Fixture, raw: Record<string, unknown>): boolean {
  const prepared = prepareReviewerFindingsForValidation({
    rawFindings: raw,
    obligationId: fixture.obligation.obligationId,
    hostConstants: {
      mandateDigest: fixture.obligation.mandateDigest,
      criteriaVersion: fixture.obligation.criteriaVersion,
    },
    hostProvenance: { childSessionId: 'ses_parity_child', reviewedAt: NOW },
  });
  if (!prepared.ok) return false;
  return (
    validateCapturedFindings(fixture.state, fixture.obligation, prepared.findings).kind === 'valid'
  );
}

function narrowedValidate(fixture: Fixture) {
  return ajv.compile(
    buildObligationFindingsJsonSchema(obligationCaptureContract(fixture.state, fixture.obligation)),
  );
}

describe('obligation-bound findings schema - parity with the capture gate', () => {
  it('fixtures cover every obligation type, counts 0/1/2 and offered refs', () => {
    expect(BASE_FIXTURES.map((fixture) => fixture.obligation.obligationType)).toEqual([
      'plan',
      'architecture',
      'implement',
      'review',
    ]);
    for (const fixture of BASE_FIXTURES) {
      expect(fixture.obligation.requiredChallengeCount, fixture.name).toBeGreaterThan(0);
      const refs = obligationCaptureContract(fixture.state, fixture.obligation).allowedEvidenceRefs;
      expect(refs?.length ?? 0, fixture.name).toBeGreaterThan(0);
    }
    const planRefs = obligationCaptureContract(
      BASE_FIXTURES[0]!.state,
      BASE_FIXTURES[0]!.obligation,
    ).allowedEvidenceRefs!;
    expect(planRefs.length).toBeGreaterThanOrEqual(2);
  });

  it.each(FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s: every gate-accepted answer is schema-accepted, and the schema is a subset of the static one',
    (_name, fixture) => {
      const narrowed = narrowedValidate(fixture);
      const acceptedVerdicts = new Set<unknown>();
      let acceptedWithChallenges = 0;
      for (const candidate of candidates(fixture)) {
        const label = JSON.stringify(candidate).slice(0, 160);
        const isStatic = staticValidate(candidate);
        const isNarrowed = narrowed(candidate);
        if (isNarrowed) expect(isStatic, `subset: ${label}`).toBe(true);
        if (isStatic && gateAccepts(fixture, candidate)) {
          acceptedVerdicts.add(candidate.overallVerdict);
          if ((candidate.challenges as unknown[]).length > 0) acceptedWithChallenges += 1;
          expect(isNarrowed, `${JSON.stringify(narrowed.errors)} ${label}`).toBe(true);
        }
      }
      // Non-vacuous: a real verdict and unable_to_review pass the gate, and with
      // a positive count the gate accepted answers that carry challenges.
      expect(acceptedVerdicts.has('unable_to_review'), fixture.name).toBe(true);
      expect(
        acceptedVerdicts.has('accept') || acceptedVerdicts.has('changes_requested'),
        fixture.name,
      ).toBe(true);
      if (fixture.obligation.requiredChallengeCount > 0) {
        expect(acceptedWithChallenges, fixture.name).toBeGreaterThan(0);
      }
    },
  );

  it('CORNER: a foreign challenge obligationId is host-stamped, so it stays expressible', () => {
    const fixture = BASE_FIXTURES[0]!;
    const refs = obligationCaptureContract(fixture.state, fixture.obligation).allowedEvidenceRefs!;
    const answer = findings(fixture, {
      challenges: [challenge(fixture, 1, [refs[0]], 'supported', { obligationId: FOREIGN_UUID })],
    });
    expect(gateAccepts(fixture, answer)).toBe(true);
    expect(narrowedValidate(fixture)(answer)).toBe(true);
  });
});

describe('obligation-bound findings schema - early rejection of gate violations', () => {
  function violations(fixture: Fixture): Array<[string, Record<string, unknown>]> {
    const refs = obligationCaptureContract(fixture.state, fixture.obligation).allowedEvidenceRefs!;
    const kind = String(fixture.obligation.requiredChallengeKind);
    const ok = (evidence: readonly unknown[], extras: Record<string, unknown> = {}) =>
      Array.from({ length: fixture.obligation.requiredChallengeCount }, (_, i) =>
        challenge(fixture, i + 1, evidence, passingOutcome(kind), extras),
      );
    const foreignRef = JSON.parse(JSON.stringify(refs[0])) as Record<string, unknown>;
    for (const key of ['artifactDigest', 'implementationDigest', 'digest']) {
      if (typeof foreignRef[key] === 'string') foreignRef[key] = 'f'.repeat(64);
    }
    if (foreignRef.kind === 'validation_attempt') foreignRef.attemptId = FOREIGN_UUID;
    const out: Array<[string, Record<string, unknown>]> = [
      [
        'iteration',
        findings(fixture, {
          iteration: fixture.obligation.iteration + 1,
          challenges: ok([refs[0]]),
        }),
      ],
      [
        'planVersion',
        findings(fixture, {
          planVersion: fixture.obligation.planVersion + 1,
          challenges: ok([refs[0]]),
        }),
      ],
      [
        'toolObligationId',
        findings(fixture, {
          attestation: { toolObligationId: FOREIGN_UUID },
          challenges: ok([refs[0]]),
        }),
      ],
      ['foreign ref', findings(fixture, { challenges: ok([foreignRef]) })],
    ];
    const otherKind = kind === 'design_challenge' ? 'content_challenge' : 'design_challenge';
    out.push([
      'challenge kind',
      findings(fixture, { challenges: ok([refs[0]], { kind: otherKind }) }),
    ]);
    if (refs.length >= 2 && refs[0]!.kind === 'plan_adr_section') {
      out.push([
        'section cross-combination',
        findings(fixture, {
          challenges: ok([{ ...refs[0], sectionPath: refs[1]!.sectionPath }]),
        }),
      ]);
    }
    return out;
  }

  it.each(BASE_FIXTURES.map((fixture) => [fixture.name, fixture] as const))(
    '%s: the schema rejects what the gate rejects by exact equality',
    (_name, fixture) => {
      const narrowed = narrowedValidate(fixture);
      for (const [label, answer] of violations(fixture)) {
        expect(gateAccepts(fixture, answer), `gate ${label}`).toBe(false);
        expect(narrowed(answer), `schema ${label}`).toBe(false);
      }
    },
  );

  it('EDGE: offered-but-empty refs admit no challenge, matching the gate', () => {
    const fixture = BASE_FIXTURES[0]!;
    const contract = {
      ...obligationCaptureContract(fixture.state, fixture.obligation),
      allowedEvidenceRefs: [],
    };
    const validate = ajv.compile(buildObligationFindingsJsonSchema(contract));
    const anyRef = obligationCaptureContract(
      fixture.state,
      fixture.obligation,
    ).allowedEvidenceRefs!;
    const withChallenge = findings(fixture, {
      challenges: [challenge(fixture, 1, [anyRef[0]], 'supported')],
    });
    expect(validate(withChallenge)).toBe(false);
    expect(
      validateChallengeConsistency({
        overallVerdict: 'accept',
        requiredChallengeCount: 1,
        requiredChallengeKind: 'design_challenge',
        challenges: withChallenge.challenges as never,
        allowedEvidenceRefs: [],
      }).ok,
    ).toBe(false);
    expect(validate(findings(fixture, { overallVerdict: 'unable_to_review' }))).toBe(true);
  });
});

describe('obligation-bound findings schema - dispatch-to-capture contract drift', () => {
  it('reports validation-attempt refs that did not exist when the child was dispatched', () => {
    const fixture = BASE_FIXTURES[2]!;
    const { allowedEvidenceRefs } = obligationCaptureContract(fixture.state, fixture.obligation);
    expect(
      refsAddedAfterDispatch(fixture.state, allowedEvidenceRefs, '2026-10-19T00:00:00.000Z'),
    ).toEqual([ATTEMPT_A, ATTEMPT_B]);
    expect(refsAddedAfterDispatch(fixture.state, allowedEvidenceRefs, NOW)).toEqual([]);
    // Frozen refs (plan/ADR sections, content) can never be added after dispatch.
    const plan = BASE_FIXTURES[0]!;
    expect(
      refsAddedAfterDispatch(
        plan.state,
        obligationCaptureContract(plan.state, plan.obligation).allowedEvidenceRefs,
        '2000-01-01T00:00:00.000Z',
      ),
    ).toEqual([]);
  });
});
