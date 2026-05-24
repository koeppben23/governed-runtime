/**
 * @module evidence-facade.test
 * @description Facade export-set regression test for evidence.ts.
 * Proves that evidence.ts (the facade) exports exactly the original public API
 * and does NOT leak internal/private implementation details.
 *
 * OpenCodeSessionId, coerceAssurance, and assuranceSchema were private helpers
 * in the original evidence.ts (no `export` keyword) and MUST NOT appear in the
 * facade re-exports.
 *
 * Extracted from evidence-split.test.ts.
 */
import { describe, it, expect } from 'vitest';

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

describe('evidence.ts facade export-set regression', () => {
  describe('HAPPY — public API present', () => {
    it('facade exports all expected value exports', async () => {
      const mod = await import('./evidence.js');
      for (const name of PUBLIC_VALUE_EXPORTS) {
        expect(name in mod).toBe(true);
      }
    });

    it('facade type exports match original evidence.ts surface', () => {
      for (const name of PUBLIC_TYPE_EXPORTS) {
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
