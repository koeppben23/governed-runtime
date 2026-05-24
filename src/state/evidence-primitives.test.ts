/**
 * @module evidence-primitives.test
 * @description Tests for evidence-primitives module.
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';
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
import { FIXED_TIME } from './evidence-test-constants.js';

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
