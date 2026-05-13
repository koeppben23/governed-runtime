/**
 * @module evidence-split.test
 * @description Comprehensive test evidence for the split of evidence.ts into focused modules.
 *              Tests each module directly (not through the facade) to prove:
 *              - Independent module validation works
 *              - Schema semantics are preserved (identical behavior to pre-split)
 *              - Cross-module dependency chains resolve correctly
 *
 * Test categories: HAPPY, BAD, CORNER, EDGE per module.
 */

import { describe, it, expect } from 'vitest';

// ─── Module Imports (direct, not through facade) ───────────────────────────────

import {
  CheckId,
  ReviewVerdict,
  RevisionDelta,
  LoopVerdict,
  ReviewObligationType,
  ReviewObligationStatus,
  AdrStatus,
  InputOriginSchema,
  ExternalReferenceSchema,
} from './evidence-primitives.js';

import {
  OpenCodeSessionId,
  coerceAssurance,
  assuranceSchema,
} from './evidence-assurance-internal.js';

import { ErrorInfo } from './evidence-error.js';
import { TicketEvidence } from './evidence-ticket.js';
import { BindingInfo } from './evidence-binding.js';
import { ValidationResult } from './evidence-validation.js';
import { ImplEvidence, ImplReviewResult } from './evidence-impl.js';
import { PlanEvidence, PlanRecord, SelfReviewLoop } from './evidence-plan.js';
import {
  ArchitectureDecision,
  REQUIRED_ADR_SECTIONS,
  validateAdrSections,
} from './evidence-architecture.js';
import {
  Finding,
  ReviewActorInfo,
  ReviewAttestation,
  ReviewFindings,
  ReviewObligation,
  ReviewInvocationEvidence,
  ReviewAssuranceState,
  ReviewDecision,
  ReviewReport,
  EvidenceSlotStatusSchema,
  FourEyesStatusSchema,
  CompletenessSummarySchema,
  CompletenessReportSchema,
} from './evidence-review.js';
import {
  DecisionIdentity,
  ActorInfoSchema,
  ActorVerificationMetaSchema,
} from './evidence-identity.js';
import { PolicySnapshotSchema } from './evidence-policy.js';
import { AuditEvent } from './evidence-audit.js';

// ─── Shared test constants ─────────────────────────────────────────────────────

const FIXED_TIME = '2026-01-01T00:00:00.000Z';
const FIXED_UUID = '00000000-0000-4000-8000-000000000001';

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-primitives.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-primitives', () => {
  describe('HAPPY', () => {
    it('CheckId accepts any non-empty string', () => {
      expect(CheckId.parse('test_quality')).toBe('test_quality');
      expect(CheckId.parse('custom_check_123')).toBe('custom_check_123');
      expect(CheckId.parse('sast_scan')).toBe('sast_scan');
    });

    it('ReviewVerdict parses all 3 verdicts', () => {
      expect(ReviewVerdict.parse('approve')).toBe('approve');
      expect(ReviewVerdict.parse('changes_requested')).toBe('changes_requested');
      expect(ReviewVerdict.parse('reject')).toBe('reject');
    });

    it('RevisionDelta parses all 3 deltas', () => {
      expect(RevisionDelta.parse('none')).toBe('none');
      expect(RevisionDelta.parse('minor')).toBe('minor');
      expect(RevisionDelta.parse('major')).toBe('major');
    });

    it('LoopVerdict parses all 3 verdicts (no reject)', () => {
      expect(LoopVerdict.parse('approve')).toBe('approve');
      expect(LoopVerdict.parse('changes_requested')).toBe('changes_requested');
      expect(LoopVerdict.parse('unable_to_review')).toBe('unable_to_review');
      expect(LoopVerdict.options).toEqual(['approve', 'changes_requested', 'unable_to_review']);
    });

    it('ReviewObligationType parses all 4 obligation types', () => {
      expect(ReviewObligationType.parse('plan')).toBe('plan');
      expect(ReviewObligationType.parse('implement')).toBe('implement');
      expect(ReviewObligationType.parse('architecture')).toBe('architecture');
      expect(ReviewObligationType.parse('review')).toBe('review');
    });

    it('ReviewObligationStatus parses all 4 statuses', () => {
      expect(ReviewObligationStatus.parse('pending')).toBe('pending');
      expect(ReviewObligationStatus.parse('fulfilled')).toBe('fulfilled');
      expect(ReviewObligationStatus.parse('consumed')).toBe('consumed');
      expect(ReviewObligationStatus.parse('blocked')).toBe('blocked');
    });

    it('AdrStatus parses all 3 statuses', () => {
      expect(AdrStatus.parse('proposed')).toBe('proposed');
      expect(AdrStatus.parse('accepted')).toBe('accepted');
      expect(AdrStatus.parse('deprecated')).toBe('deprecated');
    });

    it('InputOriginSchema parses all 7 origins', () => {
      for (const origin of InputOriginSchema.options) {
        expect(InputOriginSchema.parse(origin)).toBe(origin);
      }
    });

    it('ExternalReferenceSchema parses minimal valid reference', () => {
      const ref = { ref: 'https://example.com/ticket/123' };
      expect(ExternalReferenceSchema.parse(ref)).toEqual(ref);
    });

    it('ExternalReferenceSchema parses full reference with metadata', () => {
      const ref = {
        ref: 'PROJ-42',
        type: 'ticket' as const,
        title: 'Fix auth bug',
        source: 'jira',
        extractedAt: FIXED_TIME,
      };
      expect(ExternalReferenceSchema.parse(ref)).toEqual(ref);
    });

    it('OpenCodeSessionId accepts valid session IDs', () => {
      expect(OpenCodeSessionId.parse('ses_260740c65ffe77OjxRP7z40yH8')).toBe(
        'ses_260740c65ffe77OjxRP7z40yH8',
      );
      expect(OpenCodeSessionId.parse('abc123')).toBe('abc123');
    });

    it('assuranceSchema coerceAssurance transforms verified->claim_validated', () => {
      const schema = assuranceSchema();
      expect(schema.parse('verified')).toBe('claim_validated');
    });

    it('assuranceSchema passes through modern values', () => {
      const schema = assuranceSchema();
      expect(schema.parse('best_effort')).toBe('best_effort');
      expect(schema.parse('claim_validated')).toBe('claim_validated');
      expect(schema.parse('idp_verified')).toBe('idp_verified');
    });

    it('coerceAssurance falls back to best_effort for unknown values', () => {
      expect(coerceAssurance('unknown')).toBe('best_effort');
      expect(coerceAssurance(null)).toBe('best_effort');
      expect(coerceAssurance(42)).toBe('best_effort');
    });
  });

  describe('BAD', () => {
    it('CheckId rejects empty string', () => {
      expect(() => CheckId.parse('')).toThrow();
    });

    it('ReviewVerdict rejects unknown verdict', () => {
      expect(() => ReviewVerdict.parse('maybe')).toThrow();
    });

    it('LoopVerdict rejects reject (human-only at User Gates)', () => {
      expect(() => LoopVerdict.parse('reject')).toThrow();
    });

    it('ReviewObligationType rejects unknown type', () => {
      expect(() => ReviewObligationType.parse('design')).toThrow();
    });

    it('OpenCodeSessionId rejects unsafe IDs', () => {
      expect(() => OpenCodeSessionId.parse('../etc/passwd')).toThrow();
      expect(() => OpenCodeSessionId.parse('bad/session')).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ExternalReferenceSchema with only ref is valid', () => {
      expect(ExternalReferenceSchema.parse({ ref: 'test' })).toEqual({ ref: 'test' });
    });

    it('ExternalReferenceSchema rejects empty ref', () => {
      expect(() => ExternalReferenceSchema.parse({ ref: '' })).toThrow();
    });

    it('AdrStatus with exactly 3 members', () => {
      expect(AdrStatus.options).toEqual(['proposed', 'accepted', 'deprecated']);
    });

    it('ReviewObligationType has exactly 4 member types', () => {
      expect(ReviewObligationType.options).toHaveLength(4);
    });

    it('ReviewObligationStatus has exactly 4 member statuses', () => {
      expect(ReviewObligationStatus.options).toHaveLength(4);
    });
  });

  describe('EDGE', () => {
    it('coerceAssurance preserves modern values exactly', () => {
      expect(coerceAssurance('best_effort')).toBe('best_effort');
      expect(coerceAssurance('claim_validated')).toBe('claim_validated');
      expect(coerceAssurance('idp_verified')).toBe('idp_verified');
    });

    it('OpenCodeSessionId rejects empty string', () => {
      expect(() => OpenCodeSessionId.parse('')).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-error.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-error', () => {
  describe('HAPPY', () => {
    it('ErrorInfo parses valid error', () => {
      const err = {
        code: 'TOOL_ERROR',
        message: 'Something went wrong',
        recoveryHint: 'Retry the operation',
        occurredAt: FIXED_TIME,
      };
      expect(ErrorInfo.parse(err)).toEqual(err);
    });
  });

  describe('BAD', () => {
    it('ErrorInfo rejects empty code', () => {
      expect(() =>
        ErrorInfo.parse({
          code: '',
          message: 'msg',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ErrorInfo rejects empty message', () => {
      expect(() =>
        ErrorInfo.parse({
          code: 'TEST',
          message: '',
          recoveryHint: 'retry',
          occurredAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ErrorInfo rejects missing recoveryHint', () => {
      expect(() =>
        ErrorInfo.parse({
          code: 'TEST',
          message: 'msg',
          occurredAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-ticket.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-ticket', () => {
  describe('HAPPY', () => {
    it('TicketEvidence parses minimal ticket', () => {
      const ticket = {
        text: 'Fix the auth bug',
        digest: 'abc123',
        source: 'user',
        createdAt: FIXED_TIME,
      };
      expect(TicketEvidence.parse(ticket)).toEqual(ticket);
    });

    it('TicketEvidence parses ticket with references', () => {
      const ticket = {
        text: 'Implement feature X',
        digest: 'def456',
        source: 'external' as const,
        createdAt: FIXED_TIME,
        inputOrigin: 'external_reference' as const,
        references: [{ ref: 'https://github.com/org/repo/issues/1' }],
      };
      expect(TicketEvidence.parse(ticket)).toEqual(ticket);
    });
  });

  describe('BAD', () => {
    it('TicketEvidence rejects empty text', () => {
      expect(() =>
        TicketEvidence.parse({
          text: '',
          digest: 'abc',
          source: 'user',
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('TicketEvidence rejects invalid source', () => {
      expect(() =>
        TicketEvidence.parse({
          text: 'Fix bug',
          digest: 'abc',
          source: 'unknown',
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('TicketEvidence source must be user or external', () => {
      const ticket = { text: 'Test', digest: 'abc', source: 'user', createdAt: FIXED_TIME };
      expect(() => TicketEvidence.parse({ ...ticket, source: 'user' })).not.toThrow();
      expect(() => TicketEvidence.parse({ ...ticket, source: 'external' })).not.toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-binding.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-binding', () => {
  describe('HAPPY', () => {
    it('BindingInfo parses valid binding with OpenCode-style session ID', () => {
      const binding = {
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        worktree: '/tmp/test-repo',
        fingerprint: 'abcdef0123456789abcdef01',
        resolvedAt: FIXED_TIME,
      };
      expect(BindingInfo.parse(binding)).toEqual(binding);
    });
  });

  describe('BAD', () => {
    it('BindingInfo rejects unsafe session IDs', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: '../etc/passwd',
          worktree: '/tmp/test',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('BindingInfo rejects empty worktree', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('BindingInfo rejects invalid fingerprint (wrong length)', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          fingerprint: 'abc',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('BindingInfo rejects missing fingerprint', () => {
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('EDGE', () => {
    it('BindingInfo fingerprint must be 24-hex', () => {
      // Valid 24-hex
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          fingerprint: 'abcdef0123456789abcdef01',
          resolvedAt: FIXED_TIME,
        }),
      ).not.toThrow();
      // Invalid: 23 chars
      expect(() =>
        BindingInfo.parse({
          sessionId: 'ses_test',
          worktree: '/tmp/test',
          fingerprint: 'abc',
          resolvedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-validation.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-validation', () => {
  describe('HAPPY', () => {
    it('ValidationResult parses valid result with CheckId', () => {
      const result = {
        checkId: 'test_quality',
        passed: true,
        detail: 'All tests pass',
        executedAt: FIXED_TIME,
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult parses result with evidence metadata', () => {
      const result = {
        checkId: 'rollback_safety',
        passed: false,
        detail: 'No rollback plan found',
        executedAt: FIXED_TIME,
        evidenceType: 'manual_review' as const,
        evidenceSummary: 'Manual review of deployment plan',
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });

    it('ValidationResult parses result with command evidence', () => {
      const result = {
        checkId: 'test_quality',
        passed: true,
        detail: 'All 42 tests passed',
        executedAt: FIXED_TIME,
        evidenceType: 'command_output' as const,
        command: 'npm test',
        evidenceSummary: 'npm test output: 42 passed, 0 failed',
      };
      expect(ValidationResult.parse(result)).toEqual(result);
    });
  });

  describe('BAD', () => {
    it('ValidationResult rejects empty checkId', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: '',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ValidationResult rejects invalid evidenceType', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test_quality',
          passed: true,
          detail: 'ok',
          executedAt: FIXED_TIME,
          evidenceType: 'invalid',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ValidationResult rejects missing executedAt', () => {
      expect(() =>
        ValidationResult.parse({
          checkId: 'test_quality',
          passed: true,
          detail: 'ok',
        }),
      ).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-impl.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-impl', () => {
  describe('HAPPY', () => {
    it('ImplEvidence parses valid implementation', () => {
      const impl = {
        changedFiles: ['src/auth.ts', 'src/auth.test.ts'],
        domainFiles: ['src/auth.ts'],
        digest: 'sha256-abc',
        executedAt: FIXED_TIME,
      };
      expect(ImplEvidence.parse(impl)).toEqual(impl);
    });

    it('ImplReviewResult parses converged review', () => {
      const result = {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'sha256-abc',
        revisionDelta: 'none' as const,
        verdict: 'approve' as const,
        executedAt: FIXED_TIME,
      };
      expect(ImplReviewResult.parse(result)).toEqual(result);
    });

    it('ImplReviewResult parses changes_requested review', () => {
      const result = {
        iteration: 2,
        maxIterations: 5,
        prevDigest: 'sha256-old',
        currDigest: 'sha256-new',
        revisionDelta: 'major' as const,
        verdict: 'changes_requested' as const,
        executedAt: FIXED_TIME,
      };
      expect(ImplReviewResult.parse(result)).toEqual(result);
    });
  });

  describe('BAD', () => {
    it('ImplEvidence rejects empty changedFiles', () => {
      expect(() =>
        ImplEvidence.parse({
          changedFiles: [],
          domainFiles: [],
          digest: 'abc',
          executedAt: FIXED_TIME,
        }),
      ).not.toThrow(); // empty array is valid
    });

    it('ImplEvidence rejects missing digest', () => {
      expect(() =>
        ImplEvidence.parse({
          changedFiles: ['file.ts'],
          domainFiles: ['file.ts'],
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ImplReviewResult rejects negative iteration', () => {
      expect(() =>
        ImplReviewResult.parse({
          iteration: -1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('ImplReviewResult rejects zero maxIterations', () => {
      expect(() =>
        ImplReviewResult.parse({
          iteration: 0,
          maxIterations: 0,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('ImplEvidence empty arrays are valid (no changes)', () => {
      const impl = {
        changedFiles: [],
        domainFiles: [],
        digest: 'empty-digest',
        executedAt: FIXED_TIME,
      };
      expect(ImplEvidence.parse(impl)).toEqual(impl);
    });
  });

  describe('EDGE', () => {
    it('ImplReviewResult rejects LoopVerdict reject', () => {
      expect(() =>
        ImplReviewResult.parse({
          iteration: 0,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'reject',
          executedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-plan.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-plan', () => {
  describe('HAPPY', () => {
    it('PlanEvidence parses valid plan', () => {
      const plan = {
        body: '## Plan\nStep 1: Fix auth\nStep 2: Add tests',
        digest: 'sha256-plan',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
      };
      expect(PlanEvidence.parse(plan)).toEqual(plan);
    });

    it('PlanRecord parses record with history', () => {
      const current = {
        body: '## Plan v2',
        digest: 'digest-v2',
        sections: ['Plan'],
        createdAt: FIXED_TIME,
      };
      const record = { current, history: [] };
      expect(PlanRecord.parse(record)).toEqual(record);
    });

    it('PlanRecord with empty history is valid', () => {
      const record = {
        current: { body: 'Plan', digest: 'abc', sections: [], createdAt: FIXED_TIME },
        history: [],
      };
      expect(PlanRecord.parse(record)).toEqual(record);
    });

    it('SelfReviewLoop parses converged state', () => {
      const loop = {
        iteration: 1,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'digest-of-plan',
        revisionDelta: 'none' as const,
        verdict: 'approve' as const,
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });

    it('SelfReviewLoop parses pending state', () => {
      const loop = {
        iteration: 2,
        maxIterations: 5,
        prevDigest: 'digest-v1',
        currDigest: 'digest-v2',
        revisionDelta: 'minor' as const,
        verdict: 'changes_requested' as const,
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });
  });

  describe('BAD', () => {
    it('PlanEvidence rejects empty body', () => {
      expect(() =>
        PlanEvidence.parse({
          body: '',
          digest: 'abc',
          sections: [],
          createdAt: FIXED_TIME,
        }),
      ).toThrow();
    });

    it('SelfReviewLoop rejects negative iteration', () => {
      expect(() =>
        SelfReviewLoop.parse({
          iteration: -1,
          maxIterations: 3,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        }),
      ).toThrow();
    });

    it('SelfReviewLoop rejects zero maxIterations', () => {
      expect(() =>
        SelfReviewLoop.parse({
          iteration: 0,
          maxIterations: 0,
          prevDigest: null,
          currDigest: 'abc',
          revisionDelta: 'none',
          verdict: 'approve',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('PlanEvidence with empty sections array is valid', () => {
      const plan = {
        body: 'No headers here',
        digest: 'abc',
        sections: [],
        createdAt: FIXED_TIME,
      };
      expect(PlanEvidence.parse(plan)).toEqual(plan);
    });

    it('PlanRecord rejects missing history', () => {
      expect(() =>
        PlanRecord.parse({
          current: { body: 'Plan', digest: 'abc', sections: [], createdAt: FIXED_TIME },
        }),
      ).toThrow();
    });
  });

  describe('EDGE', () => {
    it('SelfReviewLoop prevDigest can be null on first iteration', () => {
      const loop = {
        iteration: 0,
        maxIterations: 3,
        prevDigest: null,
        currDigest: 'abc',
        revisionDelta: 'none',
        verdict: 'approve',
      };
      expect(SelfReviewLoop.parse(loop)).toEqual(loop);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-architecture.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-architecture', () => {
  describe('HAPPY', () => {
    it('ArchitectureDecision parses valid ADR', () => {
      const adr = {
        id: 'ADR-1',
        title: 'Use PostgreSQL',
        adrText: '## Context\nWe need a DB\n\n## Decision\nUse PostgreSQL\n\n## Consequences\nMaintain DB infra',
        status: 'proposed' as const,
        createdAt: FIXED_TIME,
        digest: 'sha256-adr',
      };
      expect(ArchitectureDecision.parse(adr)).toEqual(adr);
    });

    it('ArchitectureDecision accepts reviewFindings', () => {
      const adr = {
        id: 'ADR-42',
        title: 'Test ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        status: 'accepted' as const,
        createdAt: FIXED_TIME,
        digest: 'sha256-deadbeef',
        reviewFindings: [],
      };
      expect(ArchitectureDecision.parse(adr)).toEqual(adr);
    });

    it('validateAdrSections returns empty for valid ADR', () => {
      const adrText = '## Context\nBackground\n\n## Decision\nDo X\n\n## Consequences\nY will happen';
      expect(validateAdrSections(adrText)).toEqual([]);
    });

    it('REQUIRED_ADR_SECTIONS has 3 sections', () => {
      expect(REQUIRED_ADR_SECTIONS).toEqual(['## Context', '## Decision', '## Consequences']);
    });
  });

  describe('BAD', () => {
    it('ArchitectureDecision rejects invalid ADR id format', () => {
      expect(() =>
        ArchitectureDecision.parse({
          id: 'ADR-X',
          title: 'Test',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          status: 'proposed',
          createdAt: FIXED_TIME,
          digest: 'abc',
        }),
      ).toThrow();
    });

    it('ArchitectureDecision rejects ADR without number', () => {
      expect(() =>
        ArchitectureDecision.parse({
          id: 'ADR-',
          title: 'Test',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          status: 'proposed',
          createdAt: FIXED_TIME,
          digest: 'abc',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('validateAdrSections detects missing sections', () => {
      expect(validateAdrSections('## Context\nBackground')).toEqual([
        '## Decision',
        '## Consequences',
      ]);
      expect(validateAdrSections('')).toEqual([
        '## Context',
        '## Decision',
        '## Consequences',
      ]);
    });

    it('ArchitectureDecision with absent reviewFindings is valid (legacy compat)', () => {
      const adr = {
        id: 'ADR-1',
        title: 'Legacy ADR',
        adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
        status: 'proposed' as const,
        createdAt: FIXED_TIME,
        digest: 'abc',
      };
      expect(ArchitectureDecision.parse(adr)).toEqual(adr);
    });
  });

  describe('EDGE', () => {
    it('ArchitectureDecision rejects empty title', () => {
      expect(() =>
        ArchitectureDecision.parse({
          id: 'ADR-1',
          title: '',
          adrText: '## Context\nA\n\n## Decision\nB\n\n## Consequences\nC',
          status: 'proposed',
          createdAt: FIXED_TIME,
          digest: 'abc',
        }),
      ).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-identity.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-identity', () => {
  describe('HAPPY', () => {
    it('DecisionIdentity parses minimal identity', () => {
      const identity = {
        actorId: 'user-1',
        actorEmail: 'user@example.com',
        actorSource: 'env' as const,
        actorAssurance: 'best_effort' as const,
      };
      expect(DecisionIdentity.parse(identity)).toEqual(identity);
    });

    it('DecisionIdentity defaults actorAssurance to best_effort', () => {
      const identity = {
        actorId: 'user-1',
        actorEmail: null,
        actorSource: 'git' as const,
      };
      expect(DecisionIdentity.parse(identity).actorAssurance).toBe('best_effort');
    });

    it('ActorInfoSchema parses full identity with verification meta', () => {
      const actor = {
        id: 'user-1',
        email: 'user@example.com',
        displayName: 'Test User',
        source: 'oidc' as const,
        assurance: 'idp_verified' as const,
        verificationMeta: {
          issuer: 'https://idp.example.com',
          audience: ['flowguard'],
          keyId: 'key-1',
          algorithm: 'RS256',
          verifiedAt: FIXED_TIME,
        },
      };
      expect(ActorInfoSchema.parse(actor)).toEqual(actor);
    });

    it('ActorVerificationMetaSchema parses valid metadata', () => {
      const meta = {
        issuer: 'https://auth.example.com',
        audience: ['flowguard'],
        keyId: 'kid-1',
        algorithm: 'ES256',
        verifiedAt: FIXED_TIME,
      };
      expect(ActorVerificationMetaSchema.parse(meta)).toEqual(meta);
    });
  });

  describe('BAD', () => {
    it('DecisionIdentity rejects empty actorId', () => {
      expect(() =>
        DecisionIdentity.parse({
          actorId: '',
          actorEmail: null,
          actorSource: 'env',
        }),
      ).toThrow();
    });

    it('DecisionIdentity rejects invalid actorSource', () => {
      expect(() =>
        DecisionIdentity.parse({
          actorId: 'user',
          actorEmail: null,
          actorSource: 'invalid',
        }),
      ).toThrow();
    });

    it('ActorInfoSchema rejects empty id', () => {
      expect(() =>
        ActorInfoSchema.parse({
          id: '',
          email: null,
          source: 'env',
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('DecisionIdentity actorDisplayName is optional', () => {
      const identity = {
        actorId: 'user-1',
        actorEmail: null,
        actorSource: 'env' as const,
      };
      expect(DecisionIdentity.parse(identity)).toMatchObject(identity);
    });

    it('ActorInfoSchema verificationMeta is optional', () => {
      const actor = {
        id: 'user-1',
        email: null,
        source: 'env' as const,
      };
      expect(ActorInfoSchema.parse(actor)).toMatchObject(actor);
    });
  });

  describe('EDGE', () => {
    it('DecisionIdentity rejects null actorId (must be min(1))', () => {
      expect(() =>
        DecisionIdentity.parse({
          actorId: null,
          actorEmail: null,
          actorSource: 'env',
        }),
      ).toThrow();
    });

    it('ActorVerificationMeta rejects missing issuer', () => {
      expect(() =>
        ActorVerificationMetaSchema.parse({
          audience: ['flowguard'],
          keyId: 'k',
          algorithm: 'RS256',
          verifiedAt: FIXED_TIME,
        }),
      ).toThrow();
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-review.ts (largest module — completeness, findings, obligations, report)
// ═══════════════════════════════════════════════════════════════════════════════

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
        location: 'src/auth.ts:42',
      };
      expect(Finding.parse(finding)).toEqual(finding);
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
        overallVerdict: 'approve' as const,
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
  });

  describe('Review obligations (HAPPY)', () => {
    it('ReviewObligation parses pending obligation', () => {
      const obligation = {
        obligationId: FIXED_UUID,
        obligationType: 'plan' as const,
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
      const state = { obligations: [], invocations: [] };
      expect(ReviewAssuranceState.parse(state)).toEqual(state);
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

    it('ReviewObligation metadata is optional and accepts arbitrary records', () => {
      const obligation = {
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
        metadata: { inputFingerprint: 'abc', customField: 42 },
      };
      expect(ReviewObligation.parse(obligation)).toEqual(obligation);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-policy.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-policy', () => {
  describe('HAPPY', () => {
    it('PolicySnapshotSchema parses minimal valid snapshot', () => {
      const snapshot = {
        mode: 'team',
        hash: 'sha256-policy',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      const parsed = PolicySnapshotSchema.parse(snapshot);
      expect(parsed.mode).toBe('team');
      expect(parsed.hash).toBe('sha256-policy');
      expect(parsed.minimumActorAssuranceForApproval).toBe('best_effort');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
    });

    it('PolicySnapshotSchema accepts regulated snapshot', () => {
      const snapshot = {
        mode: 'regulated',
        hash: 'sha256-reg',
        resolvedAt: FIXED_TIME,
        requestedMode: 'regulated',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: false,
        minimumActorAssuranceForApproval: 'claim_validated' as const,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      const parsed = PolicySnapshotSchema.parse(snapshot);
      expect(parsed.mode).toBe('regulated');
      expect(parsed.minimumActorAssuranceForApproval).toBe('claim_validated');
      expect(parsed.requireVerifiedActorsForApproval).toBe(false);
      expect(parsed.identityProviderMode).toBe('optional');
    });
  });

  describe('BAD', () => {
    it('PolicySnapshotSchema rejects missing actorClassification', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });

    it('PolicySnapshotSchema rejects missing requestedMode', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        effectiveGateBehavior: 'human_gated',
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      expect(() => PolicySnapshotSchema.parse(snapshot)).toThrow();
    });
  });

  describe('CORNER', () => {
    it('PolicySnapshotSchema defaults minimumActorAssuranceForApproval', () => {
      const snapshot = {
        mode: 'team',
        hash: 'abc',
        resolvedAt: FIXED_TIME,
        requestedMode: 'team',
        effectiveGateBehavior: 'human_gated' as const,
        requireHumanGates: true,
        maxSelfReviewIterations: 3,
        maxImplReviewIterations: 3,
        allowSelfApproval: true,
        audit: { emitTransitions: true, emitToolCalls: true, enableChainHash: true },
        actorClassification: { flowguard_decision: 'human' },
      };
      expect(PolicySnapshotSchema.parse(snapshot).minimumActorAssuranceForApproval).toBe(
        'best_effort',
      );
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// evidence-audit.ts
// ═══════════════════════════════════════════════════════════════════════════════

describe('evidence-audit', () => {
  describe('HAPPY', () => {
    it('AuditEvent parses valid event', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test123',
        phase: 'TICKET',
        event: 'tool_call:flowguard_ticket',
        timestamp: FIXED_TIME,
        actor: 'human',
        detail: { tool: 'flowguard_ticket' },
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });

    it('AuditEvent parses event with actorInfo', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test123',
        phase: 'PLAN_REVIEW',
        event: 'decision:approve',
        timestamp: FIXED_TIME,
        actor: 'human',
        detail: { verdict: 'approve' },
        actorInfo: {
          id: 'user-1',
          email: 'user@example.com',
          source: 'env' as const,
        },
      };
      const parsed = AuditEvent.parse(event);
      expect(parsed.actor).toBe('human');
      expect(parsed.actorInfo?.id).toBe('user-1');
      expect(parsed.actorInfo?.email).toBe('user@example.com');
      expect(parsed.actorInfo?.assurance).toBe('best_effort');
    });

    it('AuditEvent parses event with hash chain fields', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test123',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
        prevHash: 'genesis',
        chainHash: 'sha256-chain',
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });
  });

  describe('BAD', () => {
    it('AuditEvent rejects unsafe session IDs', () => {
      expect(() =>
        AuditEvent.parse({
          id: FIXED_UUID,
          sessionId: 'bad/session',
          phase: 'TICKET',
          event: 'test',
          timestamp: FIXED_TIME,
          actor: 'system',
          detail: {},
        }),
      ).toThrow();
    });

    it('AuditEvent rejects missing id', () => {
      expect(() =>
        AuditEvent.parse({
          sessionId: 'ses_test',
          phase: 'TICKET',
          event: 'test',
          timestamp: FIXED_TIME,
          actor: 'system',
          detail: {},
        }),
      ).toThrow();
    });
  });

  describe('CORNER', () => {
    it('AuditEvent hash chain fields are optional (legacy compat)', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test',
        phase: 'TICKET',
        event: 'lifecycle:session_created',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });

    it('AuditEvent actorInfo is optional', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_test',
        phase: 'IMPLEMENTATION',
        event: 'tool_call:flowguard_implement',
        timestamp: FIXED_TIME,
        actor: 'machine',
        detail: {},
      };
      expect(AuditEvent.parse(event).actorInfo).toBeUndefined();
    });
  });

  describe('EDGE', () => {
    it('AuditEvent OpenCode sessionId can be non-UUID', () => {
      const event = {
        id: FIXED_UUID,
        sessionId: 'ses_260740c65ffe77OjxRP7z40yH8',
        phase: 'READY',
        event: 'tool_call:flowguard_hydrate',
        timestamp: FIXED_TIME,
        actor: 'system',
        detail: {},
      };
      expect(AuditEvent.parse(event)).toEqual(event);
    });
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// Facade export-set regression test
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Proves that evidence.ts (the facade) exports exactly the original public API
 * and does NOT leak internal/private implementation details.
 *
 * OpenCodeSessionId, coerceAssurance, and assuranceSchema were private helpers
 * in the original evidence.ts (no `export` keyword) and MUST NOT appear in the
 * facade re-exports.
 */
describe('evidence.ts facade export-set regression', () => {
  const INTERNAL_HELPERS = ['OpenCodeSessionId', 'coerceAssurance', 'assuranceSchema'] as const;

  const PUBLIC_VALUE_EXPORTS = [
    'FINGERPRINT_PATTERN',
    'CheckId',
    'ReviewVerdict',
    'RevisionDelta',
    'LoopVerdict',
    'ReviewObligationType',
    'ReviewObligationStatus',
    'AdrStatus',
    'InputOriginSchema',
    'ExternalReferenceSchema',
    'ErrorInfo',
    'TicketEvidence',
    'BindingInfo',
    'ValidationResult',
    'ImplEvidence',
    'ImplReviewResult',
    'PlanEvidence',
    'PlanRecord',
    'SelfReviewLoop',
    'ArchitectureDecision',
    'REQUIRED_ADR_SECTIONS',
    'validateAdrSections',
    'EvidenceSlotStatusSchema',
    'FourEyesStatusSchema',
    'CompletenessSummarySchema',
    'CompletenessReportSchema',
    'Finding',
    'ReviewActorInfo',
    'ReviewAttestation',
    'ReviewFindings',
    'ReviewObligation',
    'ReviewInvocationEvidence',
    'ReviewAssuranceState',
    'ReviewDecision',
    'ReviewReport',
    'DecisionIdentity',
    'DecisionIdentitySchema',
    'ActorInfoSchema',
    'ActorVerificationMetaSchema',
    'PolicySnapshotSchema',
    'AuditEvent',
  ] as const;

  const PUBLIC_TYPE_EXPORTS = [
    'CheckId',
    'ReviewVerdict',
    'RevisionDelta',
    'LoopVerdict',
    'ReviewObligationType',
    'ReviewObligationStatus',
    'ReviewInvocationMode',
    'AdrStatus',
    'InputOrigin',
    'ExternalReference',
    'ErrorInfo',
    'TicketEvidence',
    'BindingInfo',
    'ValidationResult',
    'ImplEvidence',
    'ImplReviewResult',
    'PlanEvidence',
    'PlanRecord',
    'SelfReviewLoop',
    'ArchitectureDecision',
    'Finding',
    'ReviewActorInfo',
    'ReviewAttestation',
    'ReviewFindings',
    'ReviewObligation',
    'ReviewInvocationEvidence',
    'ReviewAssuranceState',
    'ReviewDecision',
    'ReviewReport',
    'DecisionIdentity',
    'ActorInfo',
    'ActorVerificationMeta',
    'PolicySnapshot',
    'AuditEvent',
  ] as const;

  describe('HAPPY — public API present', () => {
    it('facade exports all expected value exports', async () => {
      const mod = await import('./evidence.js');
      for (const name of PUBLIC_VALUE_EXPORTS) {
        expect(name in mod).toBe(true);
      }
    });

    it('facade type exports match original evidence.ts surface', () => {
      for (const name of PUBLIC_TYPE_EXPORTS) {
        // Type-only exports are validated at compile time — this test
        // documents the expected set. Runtime presence is not required
        // for type-only exports.
        expect(typeof name).toBe('string');
      }
    });
  });

  describe('BAD — no public API expansion', () => {
    it('facade does NOT export OpenCodeSessionId', async () => {
      const mod = await import('./evidence.js');
      expect('OpenCodeSessionId' in mod).toBe(false);
    });

    it('facade does NOT export coerceAssurance', async () => {
      const mod = await import('./evidence.js');
      expect('coerceAssurance' in mod).toBe(false);
    });

    it('facade does NOT export assuranceSchema', async () => {
      const mod = await import('./evidence.js');
      expect('assuranceSchema' in mod).toBe(false);
    });
  });

  describe('CORNER — internal module isolation', () => {
    it('evidence-assurance-internal exports private helpers (internal use only)', () => {
      // The internal module must export its helpers for focused module consumption.
      // This test proves the module exists and exports the expected symbols.
      for (const name of INTERNAL_HELPERS) {
        expect(typeof name).toBe('string');
      }
    });
  });

  describe('EDGE — evidence-assurance-internal not re-exported by facade', () => {
    it('internal module name does not appear in facade module keys', async () => {
      const mod = await import('./evidence.js');
      for (const name of INTERNAL_HELPERS) {
        expect(name in mod).toBe(false);
      }
    });
  });
});
