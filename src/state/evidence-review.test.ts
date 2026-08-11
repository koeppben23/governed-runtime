/**
 * @module evidence-review.test
 * @description Tests for evidence-review module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
import {
  Finding,
  PlanAdrSectionRef,
  ImplementationRef,
  ValidationAttemptRef,
  ContentRef,
  ReviewChallenge,
  ChallengeResolution,
  ReviewActorInfo,
  ReviewAttestation,
  ReviewFindings,
  ReviewObligation,
  ReviewInvocationEvidence,
  ReviewProfile,
  ReviewProfileSource,
  ReviewAssuranceState,
  ReviewDecision,
  ReviewReport,
  EvidenceSlotStatusSchema,
  FourEyesStatusSchema,
  CompletenessSummarySchema,
  CompletenessReportSchema,
  classifyRepositoryPath,
  RepositoryLocation,
  ReviewSubjectScope,
  FrozenReviewSubject,
} from './evidence-review.js';
import { FIXED_TIME, FIXED_UUID } from './evidence-test-constants.js';

describe('evidence-review', () => {
  describe('Completeness schemas (HAPPY)', () => {
    it('EvidenceSlotStatusSchema parses valid slot', () => {
      const slot = {
        slot: 'ticket',
        label: 'Ticket Evidence',
        required: true,
        present: true,
        status: 'complete' as const,
      };
      expect(EvidenceSlotStatusSchema.parse(slot)).toEqual(slot);
    });

    it('FourEyesStatusSchema parses satisfied four-eyes', () => {
      const status = {
        required: true,
        satisfied: true,
        initiatedBy: 'user-a',
        decidedBy: 'user-b',
        detail: 'Four-eyes satisfied: reviewed by different user',
      };
      expect(FourEyesStatusSchema.parse(status)).toEqual(status);
    });

    it('CompletenessReportSchema parses full report', () => {
      const report = {
        sessionId: FIXED_UUID,
        phase: 'COMPLETE',
        policyMode: 'regulated',
        overallComplete: true,
        slots: [
          {
            slot: 'ticket',
            label: 'Ticket',
            required: true,
            present: true,
            status: 'complete' as const,
          },
        ],
        fourEyes: {
          required: true,
          satisfied: true,
          initiatedBy: 'user-a',
          decidedBy: 'user-b',
          detail: 'OK',
        },
        summary: { total: 1, complete: 1, missing: 0, notYetRequired: 0, failed: 0 },
      };
      expect(CompletenessReportSchema.parse(report)).toEqual(report);
    });
  });

  describe('Review findings (HAPPY)', () => {
    it('Finding parses valid finding', () => {
      const finding = {
        severity: 'major' as const,
        category: 'correctness' as const,
        message: 'Missing edge case handling',
        relation: {
          subjectAnchors: [
            {
              kind: 'repository_location' as const,
              location: { path: 'src/auth.ts', revision: 'head' as const, line: 42 },
            },
          ],
          evidenceLocations: [{ path: 'src/auth.ts', revision: 'head' as const, line: 42 }],
        },
      };
      expect(Finding.parse(finding)).toEqual(finding);
    });

    it('normalizes repository paths and rejects ambiguous path forms', () => {
      expect(
        RepositoryLocation.parse({ path: './src/auth.ts', revision: 'base', line: 1, endLine: 2 }),
      ).toEqual({ path: 'src/auth.ts', revision: 'base', line: 1, endLine: 2 });
      expect(RepositoryLocation.parse({ path: 'src/a/../b.ts', revision: 'head' })).toEqual({
        path: 'src/b.ts',
        revision: 'head',
      });
      for (const path of [
        '../secret.ts',
        '/etc/passwd',
        'file:///tmp/x',
        'C:\\repo\\x.ts',
        'src/\0x.ts',
      ]) {
        expect(RepositoryLocation.safeParse({ path, revision: 'head' }).success).toBe(false);
      }
    });

    it('classifies repository-root escapes separately from generic invalid paths', () => {
      expect(classifyRepositoryPath('../outside.ts')).toEqual({ kind: 'escapes_repository' });
      expect(classifyRepositoryPath('/etc/passwd')).toEqual({ kind: 'invalid' });
      expect(classifyRepositoryPath('file:///tmp/evidence.ts')).toEqual({ kind: 'invalid' });
      expect(classifyRepositoryPath('src/a/../b.ts')).toEqual({
        kind: 'valid',
        normalizedPath: 'src/b.ts',
      });
    });

    it('allows empty evidence and preserves relation order while rejecting duplicate locations', () => {
      const subjectAnchors = [
        {
          kind: 'repository_location' as const,
          location: { path: 'src/b.ts', revision: 'head' as const },
        },
        {
          kind: 'repository_location' as const,
          location: { path: 'src/a.ts', revision: 'base' as const },
        },
      ];
      const evidenceLocations = [
        { path: 'docs/b.md', revision: 'head' as const },
        { path: 'docs/a.md', revision: 'base' as const },
      ];
      expect(
        Finding.parse({
          severity: 'minor',
          category: 'quality',
          message: 'test',
          relation: { subjectAnchors, evidenceLocations },
        }).relation,
      ).toEqual({ subjectAnchors, evidenceLocations });
      expect(
        Finding.safeParse({
          severity: 'minor',
          category: 'quality',
          message: 'test',
          relation: { subjectAnchors, evidenceLocations: [] },
        }).success,
      ).toBe(true);
      expect(
        Finding.safeParse({
          severity: 'minor',
          category: 'quality',
          message: 'test',
          relation: { subjectAnchors: [subjectAnchors[0], subjectAnchors[0]], evidenceLocations },
        }).success,
      ).toBe(false);
      expect(
        Finding.safeParse({
          severity: 'minor',
          category: 'quality',
          message: 'test',
          relation: {
            subjectAnchors,
            evidenceLocations: [evidenceLocations[0], evidenceLocations[0]],
          },
        }).success,
      ).toBe(false);
    });

    it('parses repository-change and artifact review subject scopes', () => {
      expect(
        ReviewSubjectScope.parse({
          kind: 'repository_change',
          paths: ['./src/auth.ts'],
          revisions: ['base', 'head'],
        }),
      ).toEqual({
        kind: 'repository_change',
        paths: ['src/auth.ts'],
        revisions: ['base', 'head'],
      });
      expect(
        ReviewSubjectScope.parse({
          kind: 'artifact',
          artifact: {
            kind: 'plan',
            digest: 'plan-digest',
            sectionPaths: [[{ headingDepth: 1, siblingIndex: 1, headingText: 'Validation' }]],
          },
        }),
      ).toBeDefined();
    });

    it('parses strict frozen repository and content subjects', () => {
      const repository = {
        kind: 'repository_change' as const,
        source: { kind: 'branch' as const, branch: 'main' },
        baseRepository: { host: 'github.com', owner: 'flowguard', name: 'core' },
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        changedPaths: ['src/auth.ts'],
        materialDigest: 'a'.repeat(64),
        subjectDigest: 'b'.repeat(64),
      };
      const parsedRepository = FrozenReviewSubject.parse(repository);
      expect(parsedRepository.kind).toBe('repository_change');
      if (parsedRepository.kind === 'repository_change') {
        expect(parsedRepository.changedPaths).toEqual(['src/auth.ts']);
      }
      const localRepository = { ...repository };
      delete (localRepository as { baseRepository?: unknown }).baseRepository;
      expect(FrozenReviewSubject.parse(localRepository)).toMatchObject({
        kind: 'repository_change',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
      });
      expect(
        FrozenReviewSubject.safeParse({ ...localRepository, baseSha: undefined }).success,
      ).toBe(false);
      const content = {
        kind: 'content' as const,
        source: { kind: 'inline' as const, mediaType: 'text' as const },
        materialDigest: 'd'.repeat(64),
        subjectDigest: 'c'.repeat(64),
        lineCount: 4,
      };
      expect(FrozenReviewSubject.parse(content)).toEqual(content);
      expect(
        ReviewSubjectScope.parse({ kind: 'content', subjectDigest: 'c'.repeat(64), lineCount: 4 }),
      ).toEqual({ kind: 'content', subjectDigest: 'c'.repeat(64), lineCount: 4 });
      expect(
        FrozenReviewSubject.safeParse({
          ...content,
          source: { kind: 'inline', mediaType: 'invalid' },
        }).success,
      ).toBe(false);
    });

    it('ReviewActorInfo parses minimal actor info', () => {
      const actor = { sessionId: 'ses_test' };
      expect(ReviewActorInfo.parse(actor)).toEqual(actor);
    });

    it('ReviewAttestation parses strict attestation', () => {
      const attestation = {
        mandateDigest: 'sha256-mandate',
        criteriaVersion: 'v1',
        toolObligationId: FIXED_UUID,
        iteration: 0,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer' as const,
      };
      expect(ReviewAttestation.parse(attestation)).toEqual(attestation);
    });

    it('ReviewFindings parses approval verdict', () => {
      const findings = {
        iteration: 1,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'accept' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: [],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses_test' },
        reviewedAt: FIXED_TIME,
      };
      expect(ReviewFindings.parse(findings)).toEqual(findings);
    });

    it('ReviewChallenge parses each evidence-bound semantic variant', () => {
      const challengeId = '11111111-1111-4111-8111-111111111111';
      const attemptId = '22222222-2222-4222-8222-222222222222';
      const common = {
        challengeId,
        obligationId: FIXED_UUID,
        scenario: 'The claimed behavior fails under an invalid input.',
        claim: 'Invalid input is rejected before persistence.',
        locations: ['src/example.ts:42'],
      };
      const design = {
        ...common,
        kind: 'design_challenge' as const,
        evidenceRefs: [
          {
            kind: 'plan_adr_section' as const,
            artifactKind: 'plan' as const,
            artifactDigest: 'plan-digest',
            sectionPath: [{ headingDepth: 1, siblingIndex: 1, headingText: 'Plan' }],
            excerptDigest: 'excerpt-digest',
          },
        ],
        outcome: 'supported' as const,
      };
      const implementation = {
        ...common,
        kind: 'implementation_challenge' as const,
        evidenceRefs: [
          { kind: 'implementation' as const, implementationDigest: 'implementation-digest' },
          { kind: 'validation_attempt' as const, attemptId },
        ],
        outcome: 'pass' as const,
      };
      const content = {
        ...common,
        kind: 'content_challenge' as const,
        evidenceRefs: [{ kind: 'content' as const, digest: 'content-digest' }],
        outcome: 'contradicted' as const,
      };

      expect(ReviewChallenge.parse(design)).toEqual(design);
      expect(ReviewChallenge.parse(implementation)).toEqual(implementation);
      expect(ReviewChallenge.parse(content)).toEqual(content);
    });

    it('ChallengeResolution binds one challenge to immutable attempt IDs', () => {
      const resolution = {
        challengeId: '11111111-1111-4111-8111-111111111111',
        implementationDigest: 'implementation-digest',
        validationAttemptIds: ['22222222-2222-4222-8222-222222222222'],
        resolvedAt: FIXED_TIME,
      };
      expect(ChallengeResolution.parse(resolution)).toEqual(resolution);
    });

    it('parses individual challenge evidence references', () => {
      expect(
        PlanAdrSectionRef.parse({
          kind: 'plan_adr_section',
          artifactKind: 'adr',
          artifactDigest: 'adr-digest',
          sectionPath: [{ headingDepth: 2, siblingIndex: 1, headingText: 'Decision' }],
          excerptDigest: 'excerpt-digest',
        }),
      ).toBeDefined();
      expect(
        ImplementationRef.parse({
          kind: 'implementation',
          implementationDigest: 'implementation-digest',
          diffDigest: 'diff-digest',
        }),
      ).toBeDefined();
      expect(
        ValidationAttemptRef.parse({ kind: 'validation_attempt', attemptId: FIXED_UUID }),
      ).toBeDefined();
      expect(ContentRef.parse({ kind: 'content', digest: 'content-digest' })).toBeDefined();
    });
  });

  describe('Review obligations (HAPPY)', () => {
    it('ReviewObligation parses pending obligation', () => {
      const obligation = {
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
        subjectDigest: 'a'.repeat(64),
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'repository_change' as const,
          paths: ['src/auth.ts'],
          revisions: ['base', 'head'],
        },
      };
      expect(ReviewObligation.parse(obligation)).toEqual(obligation);
    });

    it('ReviewInvocationEvidence parses host-task invocation', () => {
      const invocation = {
        invocationId: FIXED_UUID,
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
        parentSessionId: 'ses_parent',
        childSessionId: 'ses_child',
        agentType: 'flowguard-reviewer' as const,
        invocationMode: 'host_subagent_task' as const,
        hostVisible: true,
        promptHash: 'sha256-prompt',
        mandateDigest: 'sha256-mandate',
        criteriaVersion: 'v1',
        findingsHash: 'sha256-findings',
        invokedAt: FIXED_TIME,
        fulfilledAt: null,
        consumedByObligationId: null,
      };
      const parsed = ReviewInvocationEvidence.parse(invocation);
      expect(parsed.reviewOutputMode).toBe('structured_output');
      expect(parsed.structuredOutputUsed).toBe(true);
      expect(parsed.reviewAssuranceLevel).toBe('structured_high');
    });

    it('ReviewAssuranceState parses valid assurance state', () => {
      const state = { obligations: [], invocations: [], attempts: [] };
      expect(ReviewAssuranceState.parse(state)).toEqual(state);
    });

    it('ReviewAssuranceState rejects an assurance state without attempts', () => {
      // attempts is the invocation envelope binding depends on: an assurance
      // state without it would look valid while being permanently unbindable.
      expect(() => ReviewAssuranceState.parse({ obligations: [], invocations: [] })).toThrow();
    });
  });

  describe('Review decision (HAPPY)', () => {
    it('ReviewDecision parses approve decision', () => {
      const decision = {
        verdict: 'approve' as const,
        rationale: 'LGTM',
        decidedAt: FIXED_TIME,
        decidedBy: 'reviewer-1',
      };
      expect(ReviewDecision.parse(decision)).toEqual(decision);
    });

    it('ReviewDecision parses decision with identity', () => {
      const decision = {
        verdict: 'changes_requested' as const,
        rationale: 'Missing tests',
        decidedAt: FIXED_TIME,
        decidedBy: 'reviewer-2',
        decisionIdentity: {
          actorId: 'reviewer-2',
          actorEmail: 'r2@example.com',
          actorSource: 'env' as const,
          actorAssurance: 'best_effort' as const,
        },
      };
      expect(ReviewDecision.parse(decision)).toEqual(decision);
    });
  });

  describe('Review report (HAPPY)', () => {
    it('ReviewReport parses clean report', () => {
      const report = {
        reviewKind: 'lifecycle_review' as const,
        schemaVersion: 'flowguard-review-report.v1' as const,
        sessionId: FIXED_UUID,
        generatedAt: FIXED_TIME,
        phase: 'COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean' as const,
        completeness: {
          sessionId: FIXED_UUID,
          phase: 'COMPLETE',
          policyMode: 'team',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: 'test',
            decidedBy: null,
            detail: 'Four-eyes not required by policy',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
      };
      expect(ReviewReport.parse(report)).toEqual(report);
    });

    it('ReviewReport parses a strict content review report', () => {
      const report = {
        reviewKind: 'content_review' as const,
        schemaVersion: 'flowguard-review-report.v1' as const,
        sessionId: FIXED_UUID,
        generatedAt: FIXED_TIME,
        phase: 'REVIEW_COMPLETE',
        planDigest: null,
        implDigest: null,
        validationSummary: [],
        findings: [],
        overallStatus: 'clean' as const,
        completeness: {
          sessionId: FIXED_UUID,
          phase: 'REVIEW_COMPLETE',
          policyMode: 'team',
          overallComplete: true,
          slots: [],
          fourEyes: {
            required: false,
            satisfied: true,
            initiatedBy: 'test',
            decidedBy: null,
            detail: 'N/A',
          },
          summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
        },
        reviewSubject: {
          kind: 'content' as const,
          source: { kind: 'inline' as const, mediaType: 'text' as const },
          materialDigest: 'b'.repeat(64),
          subjectDigest: 'a'.repeat(64),
          lineCount: 1,
        },
      };
      expect(ReviewReport.parse(report)).toEqual(report);
      expect(ReviewReport.safeParse({ ...report, unexpected: true }).success).toBe(false);
    });
  });

  describe('Review (BAD)', () => {
    it('Finding rejects invalid severity', () => {
      expect(() =>
        Finding.parse({
          severity: 'trivial',
          category: 'quality',
          message: 'test',
        }),
      ).toThrow();
    });

    it('ReviewDecision rejects unknown verdict', () => {
      expect(() =>
        ReviewDecision.parse({
          verdict: 'maybe',
          rationale: 'unsure',
          decidedAt: FIXED_TIME,
          decidedBy: 'reviewer',
        }),
      ).toThrow();
    });

    it('ReviewObligation rejects obligation with missing fields', () => {
      expect(() => ReviewObligation.parse({ obligationId: FIXED_UUID })).toThrow();
    });

    it('ReviewReport rejects invalid overallStatus', () => {
      expect(() =>
        ReviewReport.parse({
          reviewKind: 'lifecycle_review',
          schemaVersion: 'flowguard-review-report.v1',
          sessionId: FIXED_UUID,
          generatedAt: FIXED_TIME,
          phase: 'COMPLETE',
          planDigest: null,
          implDigest: null,
          validationSummary: [],
          findings: [],
          overallStatus: 'perfect',
          completeness: {
            sessionId: FIXED_UUID,
            phase: 'COMPLETE',
            policyMode: 'team',
            overallComplete: true,
            slots: [],
            fourEyes: {
              required: false,
              satisfied: true,
              initiatedBy: 'test',
              decidedBy: null,
              detail: '',
            },
            summary: { total: 0, complete: 0, missing: 0, notYetRequired: 0, failed: 0 },
          },
        }),
      ).toThrow();
    });
  });

  describe('Review (CORNER)', () => {
    it('ReviewFindings accepts unable_to_review verdict', () => {
      const findings = {
        iteration: 0,
        planVersion: 1,
        reviewMode: 'subagent' as const,
        overallVerdict: 'unable_to_review' as const,
        blockingIssues: [],
        majorRisks: [],
        missingVerification: ['Context references missing'],
        scopeCreep: [],
        unknowns: [],
        reviewedBy: { sessionId: 'ses_test' },
        reviewedAt: FIXED_TIME,
      };
      expect(ReviewFindings.parse(findings)).toEqual(findings);
    });

    it('CompletenessSummary total must equal sum of parts', () => {
      const summary = { total: 10, complete: 7, missing: 2, notYetRequired: 0, failed: 1 };
      expect(CompletenessSummarySchema.parse(summary)).toEqual(summary);
    });
  });

  describe('Review (EDGE)', () => {
    it('ReviewFindings rejects decisions with reject (human-only verdict)', () => {
      expect(() =>
        ReviewFindings.parse({
          iteration: 0,
          planVersion: 1,
          reviewMode: 'subagent',
          overallVerdict: 'reject',
          blockingIssues: [],
          majorRisks: [],
          missingVerification: [],
          scopeCreep: [],
          unknowns: [],
          reviewedBy: { sessionId: 'ses_test' },
          reviewedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ReviewChallenge rejects evidence and outcomes from another semantic variant', () => {
      expect(() =>
        ReviewChallenge.parse({
          challengeId: '11111111-1111-4111-8111-111111111111',
          obligationId: FIXED_UUID,
          scenario: 'A plan claim is unsupported.',
          claim: 'The plan covers validation.',
          locations: ['docs/plan.md#Validation'],
          kind: 'design_challenge',
          evidenceRefs: [{ kind: 'content', digest: 'content-digest' }],
          outcome: 'pass',
        }),
      ).toThrow();
    });

    it('ReviewObligation metadata is optional and accepts arbitrary records', () => {
      const obligation = {
        obligationId: FIXED_UUID,
        obligationType: 'review' as const,
        subjectDigest: 'a'.repeat(64),
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'content' as const,
          subjectDigest: 'a'.repeat(64),
          lineCount: 1,
        },
        reviewSubject: {
          kind: 'content' as const,
          source: { kind: 'inline' as const, mediaType: 'text' as const },
          materialDigest: 'a'.repeat(64),
          subjectDigest: 'a'.repeat(64),
          lineCount: 1,
        },
        metadata: { inputFingerprint: 'abc', customField: 42 },
      };
      expect(ReviewObligation.parse(obligation)).toEqual(obligation);
    });

    it('ReviewObligation rejects a missing subjectDigest', () => {
      // The subject digest is the host-authoritative identity of what must be
      // reviewed. Binding compares it against the attempt, so an obligation
      // without one can never bind: it must be rejected at the schema boundary
      // rather than persisted and fail later as an unexplained subject mismatch.
      const withoutSubject = {
        obligationId: FIXED_UUID,
        obligationType: 'review' as const,
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
      };
      const result = ReviewObligation.safeParse(withoutSubject);
      expect(result.success).toBe(false);
      expect(result.error?.issues.map((issue) => issue.path.join('.'))).toContain('subjectDigest');
    });

    it('requires a frozen subject and matching subjectDigest for standalone reviews', () => {
      const base = {
        obligationId: FIXED_UUID,
        obligationType: 'review' as const,
        subjectDigest: 'a'.repeat(64),
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'content' as const,
          subjectDigest: 'a'.repeat(64),
          lineCount: 1,
        },
      };
      expect(ReviewObligation.safeParse(base).success).toBe(false);
      expect(
        ReviewObligation.safeParse({
          ...base,
          reviewSubject: {
            kind: 'content' as const,
            source: { kind: 'inline' as const, mediaType: 'text' as const },
            materialDigest: 'b'.repeat(64),
            subjectDigest: 'c'.repeat(64),
            lineCount: 1,
          },
        }).success,
      ).toBe(false);
    });
  });

  describe('ReviewProfile (Wave 1 — #730)', () => {
    it('ReviewProfile accepts core and full', () => {
      expect(ReviewProfile.parse('core')).toBe('core');
      expect(ReviewProfile.parse('full')).toBe('full');
    });

    it('ReviewProfile rejects unknown values (no off mode)', () => {
      expect(ReviewProfile.safeParse('off').success).toBe(false);
      expect(ReviewProfile.safeParse('').success).toBe(false);
      expect(ReviewProfile.safeParse('CORE').success).toBe(false);
    });

    it('ReviewProfileSource is forward-compatible for Wave 2 sources', () => {
      for (const s of [
        'policy_default',
        'runtime_required_full',
        'explicit_full_request',
        'inherited_plan_full',
      ]) {
        expect(ReviewProfileSource.parse(s)).toBe(s);
      }
      expect(ReviewProfileSource.safeParse('bogus').success).toBe(false);
    });

    it('ReviewObligation accepts frozen reviewProfile and profileSource', () => {
      const obligation = {
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
        subjectDigest: 'sha256-subject',
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'repository_change' as const,
          paths: ['src/auth.ts'],
          revisions: ['base', 'head'],
        },
        reviewProfile: 'core' as const,
        profileSource: 'policy_default' as const,
      };
      expect(ReviewObligation.parse(obligation)).toEqual(obligation);
    });

    it('ReviewObligation accepts no optional profile fields', () => {
      const legacy = {
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
        subjectDigest: 'sha256-subject',
        iteration: 0,
        planVersion: 1,
        criteriaVersion: 'v1',
        mandateDigest: 'sha256-mandate',
        createdAt: FIXED_TIME,
        pluginHandshakeAt: null,
        status: 'pending' as const,
        invocationId: null,
        blockedCode: null,
        fulfilledAt: null,
        consumedAt: null,
        reviewSubjectScope: {
          kind: 'repository_change' as const,
          paths: ['src/auth.ts'],
          revisions: ['base', 'head'],
        },
      };
      const parsed = ReviewObligation.parse(legacy);
      expect(parsed.reviewProfile).toBeUndefined();
      expect(parsed.profileSource).toBeUndefined();
    });
  });
});
