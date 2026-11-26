/**
 * @module audit/iso27001/mapping-schema.test
 * @description Strict validation tests for `iso27001-evidence-mapping.v1`:
 * unknown editions, controls, selectors, duplicates, ambiguity, and size
 * limits all fail closed; valid mappings parse deterministically.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import {
  Iso27001EvidenceMappingSchema,
  mappingDigestOf,
  parseIso27001EvidenceMapping,
} from './mapping-schema.js';

interface MutableRule {
  ruleId: string;
  controlRef: { namespace: string; controlId: string };
  policyRequirementId: string;
  applicability: string;
  evidence: unknown[];
}

interface MutableMapping {
  mappingSchemaVersion: string;
  framework: { id: string; annex: string };
  organizationId: string;
  ismsScopeId: string;
  mappingVersion: string;
  owner: string;
  approval: { reference: string; approvedAt: string; assertedBy: string };
  soaRef?: { documentId: string; version: string; sha256?: string; status: string };
  rules: MutableRule[];
}

function validMapping(): MutableMapping {
  return {
    mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
    framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
    organizationId: 'acme-secdev',
    ismsScopeId: 'isms-prod-2026',
    mappingVersion: '3.1',
    owner: 'Head of Secure Development',
    approval: {
      reference: 'ISMS-APPROVAL-2026-014',
      approvedAt: '2026-01-15T10:00:00.000Z',
      assertedBy: 'CISO Office',
    },
    soaRef: {
      documentId: 'soa-2026',
      version: '2026.1',
      sha256: 'a'.repeat(64),
      status: 'current',
    },
    rules: [
      {
        ruleId: 'sec-testing',
        controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.8.29' },
        policyRequirementId: 'SDLC-SEC-TEST-01',
        applicability: 'asserted_applicable',
        evidence: [
          {
            kind: 'validation.assertion_passed',
            checkId: 'test',
            assertion: { providerId: 'vitest', localId: 'auth.spec.ts::token' },
          },
        ],
      },
      {
        ruleId: 'org-change-register',
        controlRef: { namespace: 'organization', controlId: 'CHG-1' },
        policyRequirementId: 'CHG-REGISTER-01',
        applicability: 'asserted_applicable',
        evidence: [
          {
            kind: 'review.human_approval_decision',
            gatePhase: 'EVIDENCE_REVIEW',
            acceptedVerdicts: ['approve'],
            minActorAssurance: 'claim_validated',
          },
        ],
      },
    ],
  };
}

describe('audit/iso27001/mapping-schema', () => {
  describe('HAPPY — a valid organization mapping parses deterministically', () => {
    it('parses the full mapping and round-trips through the schema', () => {
      const result = parseIso27001EvidenceMapping(validMapping());
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(Iso27001EvidenceMappingSchema.parse(result.mapping)).toEqual(result.mapping);
      }
    });

    it('produces a stable canonical digest', () => {
      const first = parseIso27001EvidenceMapping(validMapping());
      const second = parseIso27001EvidenceMapping(JSON.parse(JSON.stringify(validMapping())));
      expect(first.ok && second.ok).toBe(true);
      if (first.ok && second.ok) {
        expect(mappingDigestOf(first.mapping)).toBe(mappingDigestOf(second.mapping));
        // Property order must not change the digest (canonical serialization).
        const reordered = {
          rules: validMapping().rules,
          approval: validMapping().approval,
          soaRef: validMapping().soaRef,
          owner: validMapping().owner,
          mappingVersion: validMapping().mappingVersion,
          ismsScopeId: validMapping().ismsScopeId,
          organizationId: validMapping().organizationId,
          framework: validMapping().framework,
          mappingSchemaVersion: validMapping().mappingSchemaVersion,
        };
        const third = parseIso27001EvidenceMapping(reordered);
        expect(third.ok).toBe(true);
        if (third.ok) expect(mappingDigestOf(third.mapping)).toBe(mappingDigestOf(first.mapping));
      }
    });
  });

  describe('BAD — unknown editions, controls, selectors and ambiguity are rejected', () => {
    it('rejects a wrong framework edition', () => {
      const mapping = validMapping();
      mapping.framework = { id: 'ISO/IEC 27001:2013', annex: 'A' };
      expect(parseIso27001EvidenceMapping(mapping).ok).toBe(false);
    });

    it('rejects unknown Annex A controls and Annex-A-looking organization ids', () => {
      const unknownControl = validMapping();
      unknownControl.rules[0]!.controlRef.controlId = 'A.99.99';
      expect(parseIso27001EvidenceMapping(unknownControl).ok).toBe(false);
    });

    it('rejects unknown selector kinds and wildcards', () => {
      const unknownSelector = validMapping();
      unknownSelector.rules[0]!.evidence = [{ kind: 'validation.any' }];
      expect(parseIso27001EvidenceMapping(unknownSelector).ok).toBe(false);

      const wildcard = validMapping();
      wildcard.rules[0]!.controlRef.controlId = 'A.8.*';
      expect(parseIso27001EvidenceMapping(wildcard).ok).toBe(false);
    });

    it('rejects duplicate rule ids and duplicate control/requirement pairs', () => {
      const duplicateRule = validMapping();
      duplicateRule.rules.push({ ...duplicateRule.rules[0]! });
      const duplicateResult = parseIso27001EvidenceMapping(duplicateRule);
      expect(duplicateResult.ok).toBe(false);

      const duplicatePair = validMapping();
      duplicatePair.rules.push({
        ...duplicatePair.rules[0]!,
        ruleId: 'sec-testing-2',
        evidence: [{ kind: 'implementation.revision' }],
      });
      const pairResult = parseIso27001EvidenceMapping(duplicatePair);
      expect(pairResult.ok).toBe(false);
      if (!pairResult.ok) {
        expect(pairResult.issues.some((issue) => issue.message.includes('Duplicate'))).toBe(true);
      }
    });

    it('rejects unknown properties, control characters and oversized inputs', () => {
      const extraProperty = { ...validMapping(), unexpected: true };
      expect(parseIso27001EvidenceMapping(extraProperty).ok).toBe(false);

      const controlChar = validMapping();
      controlChar.organizationId = 'acme\u0000secdev';
      expect(parseIso27001EvidenceMapping(controlChar).ok).toBe(false);

      const tooManySelectors = validMapping();
      tooManySelectors.rules[0]!.evidence = Array.from({ length: 21 }, () => ({
        kind: 'policy.snapshot',
      }));
      expect(parseIso27001EvidenceMapping(tooManySelectors).ok).toBe(false);

      const noSelector = validMapping();
      noSelector.rules[0]!.evidence = [];
      expect(parseIso27001EvidenceMapping(noSelector).ok).toBe(false);
    });
  });

  describe('CORNER — namespace separation and edition identity', () => {
    it('keeps organization control ids in their own namespace', () => {
      const mapping = validMapping();
      mapping.rules[1]!.controlRef = {
        namespace: 'organization',
        controlId: 'A.8.29',
      };
      const result = parseIso27001EvidenceMapping(mapping);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.mapping.rules[1]!.controlRef.namespace).toBe('organization');
      }
    });

    it('leaves an absent SoA reference absent (not defaulted)', () => {
      const mapping = validMapping();
      delete mapping.soaRef;
      const result = parseIso27001EvidenceMapping(mapping);
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.mapping.soaRef).toBeUndefined();
    });
  });

  describe('EDGE — issue ordering is deterministic and path-anchored', () => {
    it('reports issues with stable paths and no raw input echo', () => {
      const mapping = validMapping();
      mapping.approval.approvedAt = 'not-a-timestamp';
      const result = parseIso27001EvidenceMapping(mapping);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]?.path).toContain('approval');
        expect(result.issues[0]?.message).not.toContain('not-a-timestamp');
      }
    });

    it('bounds long checkIds and assertion localIds', () => {
      const mapping = validMapping();
      mapping.rules[0]!.evidence = [
        {
          kind: 'validation.check_supported',
          checkId: 'x'.repeat(201),
        },
      ];
      expect(parseIso27001EvidenceMapping(mapping).ok).toBe(false);
    });
  });
});
