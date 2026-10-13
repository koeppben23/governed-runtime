/**
 * @module audit/iso27001/project.test
 * @description Determinism, status precedence, applicability honesty, and
 * forbidden-claim tests for `iso27001-evidence-report.v1`.
 *
 * @test-policy HAPPY, BAD, CORNER, EDGE — all four categories present.
 */

import { describe, expect, it } from 'vitest';
import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { parseIso27001EvidenceMapping, mappingDigestOf } from './mapping-schema.js';
import type { Iso27001EvidenceMapping } from './mapping-schema.js';
import { Iso27001EvidenceReportSchema } from './report-schema.js';
import { projectIso27001Report } from './project.js';
import type { VerifiedEvidenceSnapshot } from './evidence.js';
import {
  makeAssertionExtraction,
  makeImplementationAttempt,
  makeIsoState,
  makeVerifiedSnapshot,
  MATCHING_LIVE_BINDING,
  TEST_ATTEMPT_ID,
} from './iso27001-test-helpers.js';
import { decisionReceipts } from '../query.js';

const LOCAL_ID = 'auth.spec.ts::rejects-invalid-token';

function mappingOf(rules: Iso27001EvidenceMapping['rules']): Iso27001EvidenceMapping {
  const result = parseIso27001EvidenceMapping({
    mappingSchemaVersion: 'iso27001-evidence-mapping.v1',
    framework: { id: 'ISO/IEC 27001:2022', annex: 'A' },
    organizationId: 'acme-secdev',
    ismsScopeId: 'isms-prod-2026',
    mappingVersion: '1.0',
    owner: 'Secure Development Lead',
    approval: {
      reference: 'ISMS-APPROVAL-2026-014',
      approvedAt: '2026-01-15T10:00:00.000Z',
      assertedBy: 'CISO Office',
    },
    rules,
  });
  if (!result.ok) throw new Error(`fixture mapping invalid: ${JSON.stringify(result.issues)}`);
  return result.mapping;
}

function happyState() {
  const extraction = makeAssertionExtraction({
    attemptId: TEST_ATTEMPT_ID,
    localId: LOCAL_ID,
    status: 'passed',
  });
  return makeIsoState({
    validationAttempts: [makeImplementationAttempt({ checkId: 'test', extraction })],
  });
}

function snapshotOf(state: ReturnType<typeof happyState>): VerifiedEvidenceSnapshot {
  return makeVerifiedSnapshot(state, []);
}

function project(input: {
  mapping: Iso27001EvidenceMapping;
  snapshot: VerifiedEvidenceSnapshot;
  generatedAt?: string;
}) {
  return projectIso27001Report({
    mapping: input.mapping,
    mappingDigest: mappingDigestOf(input.mapping),
    verified: input.snapshot,
    liveBinding: MATCHING_LIVE_BINDING,
    generatedAt: input.generatedAt ?? '2026-02-01T00:00:00.000Z',
  });
}

function a829Rule(overrides: Record<string, unknown> = {}) {
  return {
    ruleId: 'sec-testing',
    controlRef: { namespace: 'iso27001:2022/annexA', controlId: 'A.8.29' },
    policyRequirementId: 'SDLC-SEC-TEST-01',
    applicability: 'asserted_applicable',
    evidence: [
      { kind: 'validation.check_supported', checkId: 'test' },
      {
        kind: 'validation.assertion_passed',
        checkId: 'test',
        assertion: { providerId: 'vitest', localId: LOCAL_ID },
      },
    ],
    ...overrides,
  } as never;
}

describe('audit/iso27001/project', () => {
  describe('HAPPY — deterministic projection of a fully linked rule', () => {
    it('links A.8.29 evidence and reports every unmapped candidate control', () => {
      const report = project({
        mapping: mappingOf([a829Rule()]),
        snapshot: snapshotOf(happyState()),
      });
      const control = report.controls.find((entry) => entry.controlRef.controlId === 'A.8.29');
      expect(control?.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(control?.rules[0]?.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(control?.rules[0]?.selectors).toHaveLength(2);

      const unmapped = report.controls.filter((entry) => entry.status === 'NOT_MAPPED');
      expect(unmapped.map((entry) => entry.controlRef.controlId)).toEqual([
        'A.8.15',
        'A.8.25',
        'A.8.26',
        'A.8.27',
        'A.8.28',
        'A.8.32',
      ]);
    });

    it('is byte-deterministic apart from generatedAt', () => {
      const mapping = mappingOf([a829Rule()]);
      const snapshot = snapshotOf(happyState());
      const first = project({ mapping, snapshot, generatedAt: '2026-02-01T00:00:00.000Z' });
      const second = project({ mapping, snapshot, generatedAt: '2026-02-02T12:34:56.000Z' });
      expect(first.reportDigest).toBe(second.reportDigest);
      expect({ ...first, generatedAt: second.generatedAt }).toEqual(second);
    });
  });

  describe('BAD — no conformity vocabulary or overall score may exist', () => {
    it('never emits compliance conclusions or scoring fields', () => {
      const report = project({
        mapping: mappingOf([a829Rule()]),
        snapshot: snapshotOf(happyState()),
      });
      const serialized = canonicalJsonStringify(report).toLowerCase();
      for (const forbidden of [
        'iso_compliant',
        'control_satisfied',
        'certified',
        'audit_passed',
        'compliant',
        'percentage',
        'score',
        'not_applicable_by_soa',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      expect(Object.keys(report)).not.toContain('compliant');
    });

    it('rejects unknown report properties at the schema boundary', () => {
      const report = project({
        mapping: mappingOf([a829Rule()]),
        snapshot: snapshotOf(happyState()),
      });
      expect(
        Iso27001EvidenceReportSchema.safeParse({ ...report, isoCompliant: true }).success,
      ).toBe(false);
    });
  });

  describe('CORNER — asserted exclusions and mixed evidence never verify', () => {
    it('keeps an asserted exclusion NOT_VERIFIED even when all evidence is verified', () => {
      const report = project({
        mapping: mappingOf([a829Rule({ applicability: 'asserted_excluded' })]),
        snapshot: snapshotOf(happyState()),
      });
      const rule = report.controls.find((entry) => entry.controlRef.controlId === 'A.8.29')
        ?.rules[0];
      expect(rule?.status).toBe('NOT_VERIFIED');
      expect(rule?.findings.map((finding) => finding.code)).toContain(
        'APPLICABILITY_ASSERTION_UNVERIFIED',
      );
      expect(rule?.applicability.verification).toBe('not_verified');
      expect(report.soaVerification).toBe('not_verified');
    });

    it('aggregates a rule to the worst selector status', () => {
      const report = project({
        mapping: mappingOf([
          a829Rule({
            evidence: [
              { kind: 'validation.check_supported', checkId: 'test' },
              { kind: 'policy.snapshot', expectedMode: 'regulated' },
            ],
          }),
        ]),
        snapshot: snapshotOf(happyState()),
      });
      const rule = report.controls.find((entry) => entry.controlRef.controlId === 'A.8.29')
        ?.rules[0];
      expect(rule?.status).toBe('EVIDENCE_MISSING');
      expect(rule?.selectors[0]?.status).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(rule?.selectors[1]?.status).toBe('EVIDENCE_MISSING');
    });

    it('surfaces unresolved selector evidence as NOT_VERIFIED above missing', () => {
      const snapshot = snapshotOf(
        makeIsoState({ implReview: null, validationAttempts: [], reducedCeremony: null }),
      );
      const report = project({
        mapping: mappingOf([
          a829Rule({
            evidence: [
              { kind: 'implementation.revision' },
              { kind: 'validation.check_supported', checkId: 'test' },
            ],
          }),
        ]),
        snapshot,
      });
      const rule = report.controls.find((entry) => entry.controlRef.controlId === 'A.8.29')
        ?.rules[0];
      expect(rule?.status).toBe('NOT_VERIFIED');
    });
  });

  describe('EDGE — organization namespaces, limits and ownership accounting', () => {
    it('reports organization-namespaced controls separately from Annex A', () => {
      const report = project({
        mapping: mappingOf([
          a829Rule(),
          {
            ruleId: 'chg-register',
            controlRef: { namespace: 'organization', controlId: 'CHG-1' },
            policyRequirementId: 'CHG-REGISTER-01',
            applicability: 'asserted_applicable',
            evidence: [{ kind: 'policy.snapshot' }],
          } as never,
        ]),
        snapshot: snapshotOf(happyState()),
      });
      const orgControl = report.controls.find(
        (entry) => entry.controlRef.namespace === 'organization',
      );
      expect(orgControl?.controlName).toBeNull();
      expect(orgControl?.status).toBe('EVIDENCE_LINKED_VERIFIED');
    });

    it('carries all static limitations and honest ownership accounting', () => {
      const report = project({
        mapping: mappingOf([a829Rule()]),
        snapshot: snapshotOf(happyState()),
      });
      expect(report.limitations).toContain('EXTERNAL_AUTHENTICITY_NOT_ANCHORED');
      expect(report.limitations).toContain('ORGANIZATION_WIDE_DEPLOYMENT_NOT_COVERED');
      expect(report.limitations).toContain('SINGLE_COMPLETION_EXPORT_ONLY');
      expect(report.unresolvedImpacts.map((impact) => impact.reference)).toEqual([
        '#1078',
        '#1079',
        '#1080',
        '#959',
      ]);
      expect(report.unresolvedImpacts.find((impact) => impact.reference === '#959')?.status).toBe(
        'parked',
      );
      expect(report.mappingApproval.assurance).toBe('asserted_unsigned');
      expect(report.evaluation.organizationalEffectiveness).toBe(
        'out_of_scope_independent_assessment',
      );
    });

    it('reads receipts canonically and never renders a rationale', () => {
      const snapshot = snapshotOf(happyState());
      const receipts = decisionReceipts([...snapshot.events]);
      expect(receipts).toHaveLength(0);
      const report = project({
        mapping: mappingOf([a829Rule()]),
        snapshot,
      });
      expect(canonicalJsonStringify(report)).not.toContain('fixture rationale');
    });

    it('is unaffected by live binding changes for non-export selectors', () => {
      const mapping = mappingOf([
        a829Rule(),
        {
          ruleId: 'export-completion',
          controlRef: { namespace: 'organization', controlId: 'EXP-1' },
          policyRequirementId: 'EXPORT-EVIDENCE-01',
          applicability: 'asserted_applicable',
          evidence: [{ kind: 'export.completion' }],
        } as never,
      ]);
      const snapshot = snapshotOf(happyState());

      const matching = project({ mapping, snapshot });
      const unavailable = projectIso27001Report({
        mapping,
        mappingDigest: mappingDigestOf(mapping),
        verified: snapshot,
        liveBinding: {
          stateAvailable: false,
          exportCompletionPackageDigest: null,
          exportMaterializedEvent: false,
        },
        generatedAt: '2026-02-01T00:00:00.000Z',
      });

      const statusFor = (
        report: ReturnType<typeof project>,
        controlId: string,
      ): string | undefined =>
        report.controls.find((entry) => entry.controlRef.controlId === controlId)?.rules[0]?.status;

      expect(statusFor(matching, 'A.8.29')).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(statusFor(unavailable, 'A.8.29')).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(statusFor(matching, 'EXP-1')).toBe('EVIDENCE_LINKED_VERIFIED');
      expect(statusFor(unavailable, 'EXP-1')).toBe('NOT_VERIFIED');
    });
  });
});
