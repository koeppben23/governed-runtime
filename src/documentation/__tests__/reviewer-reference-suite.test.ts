/**
 * @module documentation/reviewer-reference-suite.test
 * @description Contract checks for the fixed reviewer reference suite.
 *
 * These tests establish fixture consistency and the internal coherence of the
 * independently authored gold standard. They do NOT prove that a reviewer will
 * apply the semantic rule correctly; that requires a recorded live run against
 * the same frozen subject and evidence. `behaviorStatus` therefore stays
 * `NOT_VERIFIED` for every case.
 *
 * @test-policy HAPPY, BAD, CORNER
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { PlanClaimDeclarationInput } from '../../state/proofgraph-approval.js';
import { ClaimVerificationState } from '../../state/proofgraph-primitives.js';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';
import {
  applyReviewerStepBudget,
  classifyCompletion,
  evaluateFindings,
  frozenPlanInvocation,
  parseSuiteArgs,
  selectCases,
  transportSmokeFailures,
} from '../../../demos/reviewer-reference-suite/run-live.mjs';

const ROOT = path.join(__dirname, '../../..');
const SUITE_FILE = 'demos/reviewer-reference-suite/cases.json';
const RECORD_FILE = 'demos/reviewer-reference-suite/run-record.example.json';
const REPRODUCTION_FILE = 'demos/reviewer-reference-suite/reproduction/2026-10-19-plan.json';

const readJson = (relative: string): unknown =>
  JSON.parse(readFileSync(path.join(ROOT, relative), 'utf8'));

const Finding = z
  .object({
    lane: z.enum(['blockingIssues', 'majorRisks', 'missingVerification', 'unknowns', 'scopeCreep']),
    category: z.enum(['completeness', 'correctness', 'feasibility', 'risk', 'quality']),
    severity: z.enum(['critical', 'major', 'minor', 'any']),
    reason: z.string().min(1),
  })
  .strict();

const CounterexampleDesign = z
  .object({
    kind: z.enum(['targeted_falsification', 'second_green_run', 'none']),
    faultyVariant: z.string().min(1).nullable(),
    detectsViolation: z.boolean(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.kind === 'targeted_falsification') {
      if (value.faultyVariant === null || value.detectsViolation !== true) {
        ctx.addIssue({
          code: 'custom',
          message: 'a targeted falsification needs a faulty variant and a detected violation',
        });
      }
      return;
    }
    if (value.faultyVariant !== null || value.detectsViolation !== false) {
      ctx.addIssue({
        code: 'custom',
        message: 'a non-targeted counterexample must not claim a faulty variant or detection',
      });
    }
  });

const SuiteCandidate = z
  .object({
    kind: z.enum(['build', 'test', 'lint', 'typecheck', 'format', 'security', 'coverage']),
    command: z.string().min(1),
    source: z.string().min(1),
    confidence: z.enum(['high', 'medium', 'low']),
    candidateId: z.string().min(1),
  })
  .strict();

const EvidenceAssessment = z.enum([
  'sufficient',
  'insufficient_counterexample',
  'missing_required_candidate',
  'non_executable',
  'future_phase_only',
  'not_traceable',
  'missing_executed_evidence',
]);

const ProofGraphExpectation = z
  .object({
    criticalClaim: ClaimVerificationState,
  })
  .strict();

const GoldStandard = z
  .object({
    expectedReviewerVerdict: z.enum(['accept', 'changes_requested', 'unable_to_review']),
    requiredFindings: z.array(Finding),
    forbiddenFindings: z.array(Finding),
    expectedEvidenceAssessment: EvidenceAssessment,
    expectedProofGraphStates: ProofGraphExpectation.optional(),
    rationale: z.string().min(1),
    contractRefs: z.array(z.string().min(1)).min(1),
    deterministicChecks: z.array(z.string().min(1)).min(1),
    authoredBy: z.string().min(1),
    authoredAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    reviewStatus: z.literal('approved'),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.expectedReviewerVerdict === 'accept' && value.requiredFindings.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'accept cannot require a finding',
      });
    }
    if (value.expectedReviewerVerdict !== 'accept' && value.requiredFindings.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'a non-accept verdict needs at least one required finding',
      });
    }
    const state = value.expectedProofGraphStates?.criticalClaim;
    if (state === undefined) return;
    if (value.expectedReviewerVerdict === 'accept' && state !== 'PROVEN') {
      ctx.addIssue({
        code: 'custom',
        message: 'accept must expect PROVEN when a formal claim state is declared',
      });
    }
    if (
      value.expectedReviewerVerdict === 'changes_requested' &&
      state !== 'NOT_VERIFIED' &&
      state !== 'CONTRADICTED'
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'changes_requested must expect NOT_VERIFIED or CONTRADICTED',
      });
    }
  });

const SuiteCase = z
  .object({
    caseId: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
    goldStandardType: z.enum(['plan_review', 'implementation_review']),
    fixture: z
      .object({
        workspace: z.string().min(1),
        frozenRevision: z.string().regex(/^[0-9a-f]{7,40}$/),
        ticketFile: z.string().min(1),
        executionMode: z.enum(['java_seed', 'synthetic_discovery']),
      })
      .strict(),
    phaseConstraints: z
      .object({
        requiresExecutedEvidence: z.boolean(),
        futurePhaseChecksAllowed: z.boolean(),
      })
      .strict(),
    input: z
      .object({
        subjectKind: z.enum(['plan', 'implementation']),
        planText: z.array(z.string()).min(1).optional(),
        subjectText: z.array(z.string()).min(1).optional(),
        claims: z.array(PlanClaimDeclarationInput).min(1),
        verificationCandidates: z.array(SuiteCandidate).min(1),
        evidenceRefs: z.array(z.record(z.string(), z.unknown())),
      })
      .strict()
      .superRefine((value, ctx) => {
        if (value.subjectKind === 'plan' && value.planText === undefined) {
          ctx.addIssue({ code: 'custom', message: 'a plan case needs planText' });
        }
        if (value.subjectKind === 'implementation' && value.subjectText === undefined) {
          ctx.addIssue({ code: 'custom', message: 'an implementation case needs subjectText' });
        }
      }),
    counterexampleDesign: CounterexampleDesign,
    goldStandard: GoldStandard,
    behaviorStatus: z.literal('NOT_VERIFIED'),
  })
  .strict()
  .superRefine((value, ctx) => {
    const isPlan = value.goldStandardType === 'plan_review';
    if (isPlan) {
      if (value.input.subjectKind !== 'plan') {
        ctx.addIssue({ code: 'custom', message: 'plan_review must use a plan subject' });
      }
      if (value.phaseConstraints.requiresExecutedEvidence) {
        ctx.addIssue({
          code: 'custom',
          message: 'plan review must not require executed evidence',
        });
      }
      if (value.goldStandard.expectedProofGraphStates !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'plan review must not declare formal ProofGraph claim states',
        });
      }
      return;
    }
    if (value.input.subjectKind !== 'implementation') {
      ctx.addIssue({
        code: 'custom',
        message: 'implementation_review must use an implementation subject',
      });
    }
    if (!value.phaseConstraints.requiresExecutedEvidence) {
      ctx.addIssue({
        code: 'custom',
        message: 'implementation review must require executed evidence',
      });
    }
  });

const ReferenceSuite = z
  .object({
    schemaVersion: z.literal('reviewer-reference-suite.v1'),
    suiteVersion: z.string().min(1),
    description: z.string().min(1),
    cases: z.array(SuiteCase).min(1),
  })
  .strict();

const Reproduction = z
  .object({
    schemaVersion: z.literal('reviewer-reference-reproduction.v1'),
    caseId: z.string().min(1),
    description: z.string().min(1),
    source: z
      .object({
        runDate: z.string().min(1),
        hostVersion: z.string().min(1),
        buildCommit: z.string().regex(/^[0-9a-f]{7,40}$/),
        parentSessionId: z.string().min(1),
        reviewerChildSessionId: z.string().min(1),
        parentToolPartId: z.string().min(1),
        extraction: z.string().min(1),
        redaction: z.string().min(1),
      })
      .strict(),
    frozenRevision: z
      .object({
        commit: z.string().regex(/^[0-9a-f]{7,40}$/),
        workspace: z.string().min(1),
        ticketFile: z.string().min(1),
      })
      .strict(),
    planText: z.string().min(1),
    claims: z.array(PlanClaimDeclarationInput).min(1),
  })
  .strict();

const OutputTokenMax = z.union([z.literal(32000), z.literal(65536)]);

const RunRecord = z
  .object({
    schemaVersion: z.literal('reviewer-reference-suite-run.v1'),
    suiteVersion: z.string().min(1),
    runId: z.string().min(1),
    caseId: z.string().min(1),
    goldStandardType: z.enum(['plan_review', 'implementation_review']),
    repetition: z.number().int().positive(),
    arm: z.object({ outputTokenMax: OutputTokenMax }).strict(),
    provenance: z
      .object({
        repoHead: z.string().regex(/^[0-9a-f]{7,40}$/),
        dirty: z.boolean(),
        hostVersion: z.string().min(1),
        hostBinary: z.string().min(1),
        model: z.string().min(1),
        reviewerModel: z.string().min(1).nullable(),
        reviewerEffort: z.string().min(1).nullable(),
        reviewerSteps: z.number().int().positive().nullable(),
        modelLimitOutput: z.number().int().positive().nullable(),
        variant: z.string().min(1),
        resolvedReasoning: z.record(z.string(), z.unknown()),
        serializationReasoning: z.record(z.string(), z.unknown()).optional(),
        reviewerParams: z.array(z.record(z.string(), z.unknown())).optional(),
        criteriaVersion: z.string().min(1),
        mandateDigest: z.string().min(1),
        childSessionId: z.string().min(1).nullable().optional(),
        caseCorpusDigest: z.string().regex(/^[0-9a-f]{64}$/),
        fixtureDigest: z.string().min(1),
        outputTokenMaxEnv: OutputTokenMax,
      })
      .strict(),
    completion: z
      .object({
        kind: z.enum([
          'completed',
          'truncated',
          'step_budget_exhausted',
          'aborted',
          'incomplete',
          'unverifiable',
        ]),
        finish: z.string().nullable(),
        steps: z.number().int().nonnegative(),
        inputTokens: z.number().int().nonnegative().nullable(),
        outputTokens: z.number().int().nonnegative().nullable(),
        reasoningTokens: z.number().int().nonnegative().nullable(),
        reviewReasoningTokens: z.number().int().nonnegative().nullable().optional(),
        serializationReasoningTokens: z.number().int().nonnegative().nullable().optional(),
        serializationSteps: z.number().int().nonnegative().optional(),
        hasSerializationPrompt: z.boolean().optional(),
        durationMs: z.number().int().nonnegative().nullable(),
        retries: z.number().int().nonnegative(),
      })
      .strict(),
    review: z
      .object({
        overallVerdict: z.enum(['accept', 'changes_requested', 'unable_to_review']).nullable(),
        blockingIssues: z.array(
          z
            .object({
              category: z.enum(['completeness', 'correctness', 'feasibility', 'risk', 'quality']),
              severity: z.enum(['critical', 'major', 'minor']),
              reason: z.string().min(1),
            })
            .strict(),
        ),
        majorRisks: z.array(
          z
            .object({
              category: z.enum(['completeness', 'correctness', 'feasibility', 'risk', 'quality']),
              severity: z.enum(['critical', 'major', 'minor']),
              reason: z.string().min(1),
            })
            .strict(),
        ),
        missingVerification: z.array(z.string()),
        scopeCreep: z.array(z.string()),
        unknowns: z.array(z.string()),
        challenges: z.array(
          z
            .object({
              kind: z.string().min(1),
              outcome: z.string().min(1),
            })
            .strict(),
        ),
      })
      .strict(),
    evaluation: z
      .object({
        verdictMatch: z.boolean().nullable(),
        requiredFindingMatch: z.boolean().nullable(),
        forbiddenFindingAbsent: z.boolean().nullable(),
        evidenceCitationsValid: z.boolean().nullable(),
        outcome: z.enum(['pass', 'fail', 'not_assessed']),
      })
      .strict(),
    assurance: z.enum([
      'validated',
      'experimental_only',
      'rejected',
      'inconclusive',
      'not_assessed',
    ]),
    failure: z.string().min(1).optional(),
    transport: z
      .object({
        reviewerAttempts: z.number().int().nonnegative(),
        reviewerTranscripts: z.number().int().nonnegative(),
        authorizedRearms: z.number().int().nonnegative(),
        rearmCodes: z.array(z.string()),
        truncations: z.number().int().nonnegative(),
        stepBudgetAborts: z.number().int().nonnegative(),
        totalInputTokens: z.number().int().nonnegative(),
        totalOutputTokens: z.number().int().nonnegative(),
        totalReasoningTokens: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    observedAt: z.string().datetime(),
  })
  .strict();

const suite = ReferenceSuite.parse(readJson(SUITE_FILE));
const corpusDigest = hashText(canonicalJsonStringify(suite));

function planTextOf(value: z.infer<typeof SuiteCase>): string {
  return (value.input.planText ?? []).join('\n');
}

function subjectTextOf(value: z.infer<typeof SuiteCase>): string {
  return (value.input.subjectText ?? []).join('\n');
}

function caseById(caseId: string): z.infer<typeof SuiteCase> {
  const found = suite.cases.find((entry) => entry.caseId === caseId);
  if (!found) throw new Error(`missing case: ${caseId}`);
  return found;
}

describe('reviewer reference suite', () => {
  it('HAPPY: is schema-valid, uniquely identified, and never claims verified behavior', () => {
    expect(new Set(suite.cases.map((entry) => entry.caseId)).size).toBe(suite.cases.length);
    for (const entry of suite.cases) {
      expect(entry.behaviorStatus, entry.caseId).toBe('NOT_VERIFIED');
      expect(entry.goldStandard.reviewStatus, entry.caseId).toBe('approved');
      expect(entry.goldStandard.rationale.length, entry.caseId).toBeGreaterThan(40);
    }
  });

  it('HAPPY: separates ten plan-review and five implementation-review gold standards', () => {
    const plan = suite.cases.filter((entry) => entry.goldStandardType === 'plan_review');
    const implementation = suite.cases.filter(
      (entry) => entry.goldStandardType === 'implementation_review',
    );
    expect(plan).toHaveLength(10);
    expect(implementation).toHaveLength(5);
    expect(plan.every((entry) => entry.goldStandard.expectedProofGraphStates === undefined)).toBe(
      true,
    );
    expect(
      implementation.every((entry) => entry.goldStandard.expectedProofGraphStates !== undefined),
    ).toBe(true);
  });

  it('HAPPY: every fixture, ticket, and frozen revision reference exists', () => {
    for (const entry of suite.cases) {
      expect(existsSync(path.join(ROOT, entry.fixture.workspace)), entry.caseId).toBe(true);
      expect(existsSync(path.join(ROOT, entry.fixture.ticketFile)), entry.caseId).toBe(true);
      expect(entry.fixture.frozenRevision).toMatch(/^[0-9a-f]{7,40}$/);
    }
  });

  it('HAPPY: plan subjects carry the mandatory sections and canonical claims parse', () => {
    for (const entry of suite.cases.filter((item) => item.input.subjectKind === 'plan')) {
      const text = planTextOf(entry);
      for (const heading of ['## Verification', '## Contracts', '## Authority Decisions']) {
        expect(text, `${entry.caseId} missing ${heading}`).toContain(heading);
      }
    }
    for (const entry of suite.cases) {
      expect(entry.input.claims.length, entry.caseId).toBeGreaterThan(0);
      for (const claim of entry.input.claims) {
        expect(PlanClaimDeclarationInput.safeParse(claim).success, entry.caseId).toBe(true);
        if (entry.input.subjectKind === 'plan') {
          const heading =
            claim.authoritySectionId === 'implementation-step-1'
              ? '### 1.'
              : claim.authoritySectionId === 'implementation-step-2'
                ? '### 2.'
                : `## ${claim.authoritySectionId}`;
          expect(planTextOf(entry).toLowerCase(), entry.caseId).toContain(heading.toLowerCase());
        }
      }
    }
  });

  it('HAPPY: targeted and second-green counterexample designs stay distinguishable', () => {
    const targeted = caseById('plan-a-targeted-falsification');
    expect(targeted.counterexampleDesign.kind).toBe('targeted_falsification');
    expect(targeted.counterexampleDesign.faultyVariant).toContain('HTTP 500');
    expect(targeted.counterexampleDesign.detectsViolation).toBe(true);
    expect(planTextOf(targeted)).toContain('targeted falsification');

    const secondGreen = caseById('plan-b-second-green-counterexample');
    expect(secondGreen.counterexampleDesign.kind).toBe('second_green_run');
    expect(secondGreen.counterexampleDesign.faultyVariant).toBeNull();
    expect(secondGreen.counterexampleDesign.detectsViolation).toBe(false);
    expect(planTextOf(secondGreen)).toContain('second green execution');
    expect(secondGreen.goldStandard.expectedReviewerVerdict).toBe('changes_requested');

    const r = caseById('plan-r-reproduction-plan');
    expect(r.counterexampleDesign.kind).toBe('targeted_falsification');
    expect(r.goldStandard.expectedReviewerVerdict).toBe('accept');
    expect(r.goldStandard.expectedEvidenceAssessment).toBe('sufficient');

    const rplus = caseById('plan-r-plus-explicit-red-green');
    expect(rplus.counterexampleDesign.kind).toBe('targeted_falsification');
    expect(rplus.counterexampleDesign.detectsViolation).toBe(true);
    expect(rplus.goldStandard.expectedReviewerVerdict).toBe('accept');
    expect(planTextOf(rplus)).toContain('Counterexample (RED)');
    expect(planTextOf(rplus)).toContain('Positive (GREEN)');
  });

  it('HAPPY: missing-candidate and non-executable cases are provable from the fixture', () => {
    const missing = caseById('plan-c1-missing-required-candidate');
    const candidateKinds = missing.input.verificationCandidates.map((item) => item.kind);
    expect(planTextOf(missing)).toContain('security_scan');
    expect(candidateKinds).not.toContain('security_scan');
    expect(missing.goldStandard.expectedEvidenceAssessment).toBe('missing_required_candidate');
    expect(missing.fixture.executionMode).toBe('synthetic_discovery');

    const broken = caseById('plan-c2-non-executable-check');
    expect(
      broken.input.verificationCandidates.some((item) => item.command.includes('missing-goal')),
    ).toBe(true);
    expect(planTextOf(broken)).toContain('missing-goal');
    expect(broken.goldStandard.expectedEvidenceAssessment).toBe('non_executable');
    expect(broken.fixture.executionMode).toBe('synthetic_discovery');
  });

  it('HAPPY: only synthetic-discovery cases need a non-Java-seed execution fixture', () => {
    const synthetic = suite.cases.filter(
      (entry) => entry.fixture.executionMode === 'synthetic_discovery',
    );
    expect(synthetic.map((entry) => entry.caseId).sort()).toEqual([
      'plan-c1-missing-required-candidate',
      'plan-c2-non-executable-check',
    ]);
    for (const entry of suite.cases) {
      if (entry.fixture.executionMode === 'java_seed') {
        expect(entry.fixture.workspace).toBe('demos/java-task-manager/seed');
      }
    }
  });

  it('HAPPY: future-phase checks are not treated as missing executed evidence', () => {
    const future = caseById('plan-c3-future-phase-check');
    expect(future.phaseConstraints.requiresExecutedEvidence).toBe(false);
    expect(future.phaseConstraints.futurePhaseChecksAllowed).toBe(true);
    expect(future.goldStandard.expectedReviewerVerdict).toBe('accept');
    expect(future.goldStandard.expectedEvidenceAssessment).toBe('future_phase_only');
    expect(planTextOf(future)).toContain('No executed results exist at plan time');
  });

  it('HAPPY: untraceable evidence is a block, not an invented defect', () => {
    const untraceable = caseById('plan-c4-not-traceable-evidence');
    const location = untraceable.input.evidenceRefs.find(
      (item) => item['kind'] === 'repository_location',
    );
    expect(location).toBeDefined();
    const cited = String(location?.['path']);
    expect(existsSync(path.join(ROOT, cited))).toBe(false);
    expect(untraceable.goldStandard.expectedEvidenceAssessment).toBe('not_traceable');
    expect(
      untraceable.goldStandard.requiredFindings.some(
        (item) => item.lane === 'blockingIssues' && item.category === 'completeness',
      ),
    ).toBe(true);
    expect(
      untraceable.goldStandard.forbiddenFindings.some((item) => item.category === 'correctness'),
    ).toBe(true);
  });

  it('HAPPY: the contract-violation case is traceable to the ticket', () => {
    const violation = caseById('plan-d-contract-violation');
    const ticket = readFileSync(path.join(ROOT, violation.fixture.ticketFile), 'utf8');
    expect(ticket).toContain('HTTP 404');
    const text = planTextOf(violation);
    expect(text).toContain('HTTP 200');
    expect(violation.goldStandard.expectedReviewerVerdict).toBe('changes_requested');
    expect(
      violation.goldStandard.requiredFindings.some(
        (item) => item.severity === 'critical' && item.category === 'correctness',
      ),
    ).toBe(true);
  });

  it('HAPPY: style-only controls forbid blocking style findings', () => {
    for (const caseId of ['plan-e-style-only', 'impl-e-style-only']) {
      const entry = caseById(caseId);
      expect(entry.goldStandard.expectedReviewerVerdict).toBe('accept');
      expect(
        entry.goldStandard.forbiddenFindings.some(
          (item) => item.lane === 'blockingIssues' && item.category === 'quality',
        ),
      ).toBe(true);
    }
  });

  it('HAPPY: implementation cases keep formal claim states separate from reviewer verdicts', () => {
    const proven = caseById('impl-a-executed-positive-and-adversarial');
    expect(proven.goldStandard.expectedProofGraphStates?.criticalClaim).toBe('PROVEN');
    expect(proven.goldStandard.expectedReviewerVerdict).toBe('accept');

    const contradicted = caseById('impl-d-contract-violation');
    expect(contradicted.goldStandard.expectedProofGraphStates?.criticalClaim).toBe('CONTRADICTED');
    expect(contradicted.goldStandard.expectedReviewerVerdict).toBe('changes_requested');

    const missing = caseById('impl-c-missing-executed-evidence');
    expect(missing.goldStandard.expectedProofGraphStates?.criticalClaim).toBe('NOT_VERIFIED');
    expect(
      missing.goldStandard.requiredFindings.some((item) => item.lane === 'missingVerification'),
    ).toBe(true);
  });

  it('HAPPY: R uses the exact frozen reproduction plan and claims', () => {
    const reproduction = Reproduction.parse(readJson(REPRODUCTION_FILE));
    const r = caseById('plan-r-reproduction-plan');
    expect(planTextOf(r)).toBe(reproduction.planText);
    expect(r.input.claims).toEqual(reproduction.claims);
    const rplus = caseById('plan-r-plus-explicit-red-green');
    expect(planTextOf(rplus)).toContain('Counterexample (RED)');
    expect(planTextOf(rplus)).toContain('Positive (GREEN)');
  });

  it('HAPPY: the 2026-10-19 reproduction fixture is frozen and asserts no verdict', () => {
    const reproduction = Reproduction.parse(readJson(REPRODUCTION_FILE));
    expect(reproduction.source.hostVersion).toBe('1.19.3');
    expect(reproduction.source.buildCommit).toBe('6a4ff271');
    expect(reproduction.frozenRevision.commit).toBe('6a4ff271');
    for (const heading of ['## Verification', '## Contracts', '## Authority Decisions']) {
      expect(reproduction.planText).toContain(heading);
    }
    for (const claim of reproduction.claims) {
      expect(PlanClaimDeclarationInput.safeParse(claim).success).toBe(true);
    }
    expect(reproduction).not.toHaveProperty('expectedReviewerVerdict');
  });

  it('HAPPY: the run-record example matches the schema and the corpus digest', () => {
    const record = RunRecord.parse(readJson(RECORD_FILE));
    expect(record.arm.outputTokenMax).toBe(65536);
    expect(record.provenance.outputTokenMaxEnv).toBe(65536);
    expect(record.provenance.caseCorpusDigest).toBe(corpusDigest);
    expect(record.goldStandardType).toBe('plan_review');
    expect(record.evaluation.outcome).toBe('pass');
  });

  it('BAD: a second-green case cannot smuggle in a faulty variant', () => {
    const bad = structuredClone(caseById('plan-b-second-green-counterexample'));
    bad.counterexampleDesign = {
      kind: 'second_green_run',
      faultyVariant: 'A failing variant',
      detectsViolation: false,
    };
    expect(ReferenceSuite.safeParse({ ...suite, cases: [bad] }).success).toBe(false);
  });

  it('BAD: a plan-review case cannot declare a formal ProofGraph claim state', () => {
    const bad = structuredClone(caseById('plan-a-targeted-falsification'));
    bad.goldStandard.expectedProofGraphStates = { criticalClaim: 'PROVEN' };
    expect(ReferenceSuite.safeParse({ ...suite, cases: [bad] }).success).toBe(false);
  });

  it('BAD: a case cannot claim verified behavior or omit its rationale', () => {
    const verified = structuredClone(caseById('plan-a-targeted-falsification'));
    (verified as { behaviorStatus: string }).behaviorStatus = 'VERIFIED';
    expect(ReferenceSuite.safeParse({ ...suite, cases: [verified] }).success).toBe(false);

    const unexplained = structuredClone(caseById('plan-a-targeted-falsification'));
    unexplained.goldStandard.rationale = '';
    expect(ReferenceSuite.safeParse({ ...suite, cases: [unexplained] }).success).toBe(false);
  });

  it('BAD: the run-record schema rejects an unsupported output token maximum', () => {
    const bad = structuredClone(readJson(RECORD_FILE) as Record<string, unknown>);
    (bad['arm'] as Record<string, unknown>)['outputTokenMax'] = 32768;
    expect(RunRecord.safeParse(bad).success).toBe(false);
  });

  it('CORNER: the corpus digest is stable across a JSON read/write round trip', () => {
    const roundTripped = JSON.parse(JSON.stringify(suite));
    expect(hashText(canonicalJsonStringify(roundTripped))).toBe(corpusDigest);
  });
});

describe('reference-suite live runner helpers', () => {
  const baseArgs = ['--root', '/tmp/fg-suite-root', '--tarball', '/tmp/fg-suite.tgz'];

  it('HAPPY: parses a valid arm and repetition count', () => {
    const options = parseSuiteArgs([...baseArgs, '--arm', '65536', '--repetitions', '3']);
    expect(options.arm).toBe(65536);
    expect(options.repetitions).toBe(3);
    expect(options.hostVersion).toBe('1.19.3');
    expect(options.singleReview).toBe(false);
  });

  it('HAPPY: parses the single-review mode and the step override', () => {
    expect(parseSuiteArgs([...baseArgs, '--single-review']).singleReview).toBe(true);
    expect(parseSuiteArgs([...baseArgs, '--reviewer-steps', '10']).reviewerSteps).toBe(10);
    expect(parseSuiteArgs([...baseArgs]).reviewerSteps).toBe(15);
  });

  it('BAD: rejects an unsupported arm or a non-positive repetition count', () => {
    expect(() => parseSuiteArgs([...baseArgs, '--arm', '32768'])).toThrow(/--arm/);
    expect(() => parseSuiteArgs([...baseArgs, '--repetitions', '0'])).toThrow(/positive integer/);
  });

  it('HAPPY: selects only Java-seed plan-review cases by default', () => {
    const selected = selectCases({}, suite);
    expect(selected.kind).toBe('suite');
    expect(selected.cases.length).toBeGreaterThan(0);
    expect(
      selected.cases.every(
        (entry: z.infer<typeof SuiteCase>) =>
          entry.goldStandardType === 'plan_review' && entry.fixture.executionMode === 'java_seed',
      ),
    ).toBe(true);
  });

  it('BAD: refuses synthetic-discovery and implementation-review cases', () => {
    expect(() => selectCases({ caseId: 'plan-c1-missing-required-candidate' }, suite)).toThrow(
      /not executed by this runner|no executable plan-review case selected/,
    );
    expect(() =>
      selectCases({ caseId: 'impl-a-executed-positive-and-adversarial' }, suite),
    ).toThrow(/not executed by this runner|no executable plan-review case selected/);
  });

  it('HAPPY: classifies reviewer completion from host-recorded messages', () => {
    const assistant = (finish: string, error?: unknown) => ({
      info: { role: 'assistant', finish, ...(error ? { error } : {}) },
      parts: [{ type: 'text' }],
    });
    expect(classifyCompletion([assistant('stop')])).toMatchObject({ kind: 'completed' });
    expect(classifyCompletion([assistant('length')])).toMatchObject({ kind: 'truncated' });
    expect(classifyCompletion([assistant('stop', { name: 'MessageAbortedError' })])).toMatchObject({
      kind: 'aborted',
    });
    expect(classifyCompletion(Array.from({ length: 10 }, () => assistant('stop')))).toMatchObject({
      kind: 'step_budget_exhausted',
    });
    expect(classifyCompletion(null)).toMatchObject({ kind: 'unverifiable' });
  });

  it('HAPPY: evaluates verdict and finding predicates against the gold standard', () => {
    const review = {
      overallVerdict: 'changes_requested',
      blockingIssues: [{ category: 'correctness', severity: 'major', reason: 'counterexample' }],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      challenges: [],
    };
    const gold = {
      expectedReviewerVerdict: 'changes_requested',
      requiredFindings: [
        {
          lane: 'blockingIssues',
          category: 'correctness',
          severity: 'major',
          reason: 'counterexample',
        },
      ],
      forbiddenFindings: [],
    };
    expect(evaluateFindings(review, gold)).toMatchObject({
      verdictMatch: true,
      requiredFindingMatch: true,
      forbiddenFindingAbsent: true,
      outcome: 'pass',
    });
    expect(evaluateFindings({ ...review, overallVerdict: 'accept' }, gold).outcome).toBe('fail');
  });

  it('CORNER: a missing verdict is not assessed, never a pass', () => {
    expect(
      evaluateFindings(
        {
          overallVerdict: null,
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          challenges: [],
        },
        {
          expectedReviewerVerdict: 'accept',
          requiredFindings: [],
          forbiddenFindings: [],
        },
      ).outcome,
    ).toBe('not_assessed');
  });
});

describe('reference-suite frozen-subject selection', () => {
  it('HAPPY: a later revised-plan obligation never replaces the frozen review', () => {
    const state = {
      reviewAssurance: {
        obligations: [
          { obligationId: 'o-frozen', obligationType: 'plan', subjectDigest: 'a'.repeat(64) },
          { obligationId: 'o-revised', obligationType: 'plan', subjectDigest: 'b'.repeat(64) },
        ],
        invocations: [
          { obligationId: 'o-frozen', capturedRawFindings: { overallVerdict: 'accept' } },
          {
            obligationId: 'o-revised',
            capturedRawFindings: { overallVerdict: 'changes_requested' },
          },
        ],
      },
    };
    expect(frozenPlanInvocation(state, 'a'.repeat(64))).toMatchObject({
      obligation: { obligationId: 'o-frozen' },
      invocation: { capturedRawFindings: { overallVerdict: 'accept' } },
    });
    expect(frozenPlanInvocation(state, 'c'.repeat(64))).toBeNull();
  });
});

describe('reference-suite transport smoke contract', () => {
  const record = () => ({
    failure: undefined,
    completion: {
      kind: 'completed',
      reviewReasoningTokens: 12000,
      serializationReasoningTokens: 0,
      hasSerializationPrompt: true,
    },
    review: { overallVerdict: 'accept' },
    provenance: {
      reviewerEffort: 'none',
      reviewerParams: [{ kind: 'chat.params' }, { kind: 'chat.params' }],
    },
  });

  it('HAPPY: accepts reasoning review plus non-reasoning serialization', () => {
    expect(transportSmokeFailures(record())).toEqual([]);
  });

  it('BAD: rejects reasoning during serialization', () => {
    const bad = record();
    bad.completion.serializationReasoningTokens = 42;
    expect(transportSmokeFailures(bad)).toContain('Serialisierung hat Reasoning-Tokens');
  });

  it('BAD: rejects a thinking-mode reviewer agent', () => {
    const bad = record();
    bad.provenance.reviewerEffort = 'max';
    expect(transportSmokeFailures(bad)).toContain('reviewerEffort=max');
  });

  it('BAD: rejects a review without reasoning or without a serialization prompt', () => {
    const noReasoning = record();
    noReasoning.completion.reviewReasoningTokens = 0;
    expect(transportSmokeFailures(noReasoning)).toContain(
      'fachlicher Review hat keine Reasoning-Tokens',
    );

    const noPrompt = record();
    noPrompt.completion.hasSerializationPrompt = false;
    expect(transportSmokeFailures(noPrompt)).toContain('kein Serialisierungs-Prompt beobachtet');
  });
});

describe('reference-suite reviewer step override', () => {
  it('HAPPY: applies 10 even when it equals the installed default, and can raise it to 15', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'fg-reviewer-steps-'));
    try {
      const dir = path.join(root, '.opencode', 'agents');
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, 'flowguard-reviewer.md');
      writeFileSync(file, '---\nreasoningEffort: none\nsteps: 10\n---\n', 'utf8');
      applyReviewerStepBudget(root, 10);
      expect(readFileSync(file, 'utf8')).toContain('steps: 10');
      applyReviewerStepBudget(root, 15);
      expect(readFileSync(file, 'utf8')).toContain('steps: 15');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
