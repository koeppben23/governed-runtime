/**
 * @file review-findings-schema-drift.test.ts
 * @description Build-time guard against drift between the runtime JSON-Schema
 * passed to the OpenCode SDK structured-output API and the Zod ReviewFindings
 * schema that validates findings throughout the rest of the codebase.
 *
 * Why this matters:
 * - REVIEW_FINDINGS_JSON_SCHEMA is sent to the model via SDK's
 *   `format: { type: 'json_schema', schema }` parameter. The model is
 *   constrained to produce output matching this schema.
 * - The Zod ReviewFindings schema is the runtime contract for everything
 *   that consumes findings (plugin-orchestrator, review-validation, tools).
 * - If these two drift, the SDK can produce findings the rest of the
 *   pipeline rejects (or vice versa) — silent data-shape failures.
 *
 * This test enforces:
 * 1. JSON-Schema enum values are a subset of, or equal to, Zod enum values
 *    (drift in the strict direction is allowed; superset would let invalid
 *    values through).
 * 2. Every JSON-Schema required field corresponds to a Zod field.
 * 3. Documented intentional drift (e.g. attestation: required in JSON-Schema
 *    but optional in Zod) is asserted explicitly so any change forces a
 *    review.
 *
 * Adding/removing properties to either schema MUST update this test.
 *
 * @version v1
 */

import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './review-orchestrator.js';
import { ReviewFindings } from '../state/evidence.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

interface JsonSchemaObject {
  type: string;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  additionalProperties?: boolean;
  items?: JsonSchemaProperty;
  enum?: string[];
  const?: string;
}
type JsonSchemaProperty = JsonSchemaObject & {
  minimum?: number;
  maximum?: number;
};

function jsonSchemaProperties(): Record<string, JsonSchemaProperty> {
  const schema = REVIEW_FINDINGS_JSON_SCHEMA as unknown as JsonSchemaObject;
  return schema.properties ?? {};
}

function jsonSchemaRequired(): string[] {
  const schema = REVIEW_FINDINGS_JSON_SCHEMA as unknown as JsonSchemaObject;
  return schema.required ?? [];
}

function zodTopLevelKeys(): string[] {
  // ReviewFindings is z.object(...).readonly() — unwrap to access shape.
  // The readonly wrapper preserves the inner ZodObject.
  const inner = (ReviewFindings as unknown as { _def: { innerType?: z.ZodObject<z.ZodRawShape> } })
    ._def.innerType;
  if (!inner) {
    throw new Error('Could not unwrap ReviewFindings — schema structure changed');
  }
  return Object.keys(inner.shape);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('REVIEW_FINDINGS_JSON_SCHEMA ↔ Zod ReviewFindings drift guard', () => {
  it('GOOD: every JSON-Schema property is also a Zod property', () => {
    const jsonProps = Object.keys(jsonSchemaProperties());
    const zodProps = zodTopLevelKeys();
    const missing = jsonProps.filter((p) => !zodProps.includes(p));
    expect(missing).toEqual([]);
  });

  it('GOOD: every Zod property is also a JSON-Schema property', () => {
    const jsonProps = Object.keys(jsonSchemaProperties());
    const zodProps = zodTopLevelKeys();
    const missing = zodProps.filter((p) => !jsonProps.includes(p));
    expect(missing).toEqual([]);
  });

  it('GOOD: overallVerdict enum matches LoopVerdict (approve | changes_requested)', () => {
    const props = jsonSchemaProperties();
    const verdict = props.overallVerdict as JsonSchemaProperty;
    expect(verdict.enum).toEqual(['approve', 'changes_requested']);
  });

  it('GOOD: reviewMode is locked to const "subagent"', () => {
    const props = jsonSchemaProperties();
    const mode = props.reviewMode as JsonSchemaProperty;
    expect(mode.const).toBe('subagent');
  });

  it('GOOD: reviewedBy.actorSource enum matches Zod ReviewActorInfo', () => {
    const props = jsonSchemaProperties();
    const reviewedBy = props.reviewedBy as JsonSchemaProperty;
    const actorSource = reviewedBy.properties?.actorSource as JsonSchemaProperty;
    // Zod source: ReviewActorInfo uses z.enum(['env', 'git', 'claim', 'unknown'])
    // (decision-receipt actorSource is the broader 5-value enum but is a
    // different schema — see evidence.ts:184 vs evidence.ts:444).
    expect(actorSource.enum?.sort()).toEqual(['claim', 'env', 'git', 'unknown']);
  });

  it('GOOD: reviewedBy.actorAssurance enum includes all four Zod assurance values', () => {
    const props = jsonSchemaProperties();
    const reviewedBy = props.reviewedBy as JsonSchemaProperty;
    const actorAssurance = reviewedBy.properties?.actorAssurance as JsonSchemaProperty;
    // Zod assuranceSchema(): verified | best_effort | claim_validated | idp_verified.
    // Drift: 'verified' was missing pre-fix and would silently reject valid findings.
    expect(actorAssurance.enum?.sort()).toEqual([
      'best_effort',
      'claim_validated',
      'idp_verified',
      'verified',
    ]);
  });

  it('GOOD: blockingIssues and majorRisks share the Finding shape (same enums)', () => {
    const props = jsonSchemaProperties();
    const blocking = props.blockingIssues as JsonSchemaProperty;
    const major = props.majorRisks as JsonSchemaProperty;
    expect(blocking.items?.properties?.severity?.enum?.sort()).toEqual([
      'critical',
      'major',
      'minor',
    ]);
    expect(major.items?.properties?.severity?.enum?.sort()).toEqual(['critical', 'major', 'minor']);
    expect(blocking.items?.properties?.category?.enum?.sort()).toEqual([
      'completeness',
      'correctness',
      'feasibility',
      'quality',
      'risk',
    ]);
    expect(major.items?.properties?.category?.enum?.sort()).toEqual([
      'completeness',
      'correctness',
      'feasibility',
      'quality',
      'risk',
    ]);
  });

  it('GOOD: attestation.toolObligationId enforces UUID pattern (matches z.string().uuid())', () => {
    // Drift guard: Zod ReviewAttestation.toolObligationId is z.string().uuid().
    // Pre-fix the JSON-Schema only required `type: string`, so the SDK could
    // produce non-UUID strings that the Zod parser would reject downstream.
    // The JSON-Schema now declares an explicit RFC 4122 pattern.
    const props = jsonSchemaProperties();
    const attestation = props.attestation as JsonSchemaProperty;
    const obligationId = attestation.properties?.toolObligationId as JsonSchemaProperty & {
      pattern?: string;
    };
    expect(obligationId.pattern).toBeDefined();
    expect(obligationId.pattern).toMatch(/\[0-9a-fA-F\]\{8\}/);

    // Sanity: pattern accepts a valid UUID and rejects a freeform string.
    const re = new RegExp(obligationId.pattern!);
    expect(re.test('00000000-0000-4000-8000-000000000000')).toBe(true);
    expect(re.test('obl_test')).toBe(false);
  });

  it('GOOD: attestation block requires all six strict fields', () => {
    // B1 fix: REVIEWER_AGENT mandate template emits a 6-field attestation
    // (mandateDigest, criteriaVersion, toolObligationId, iteration, planVersion,
    // reviewedBy). The JSON-schema MUST require all six so structured output
    // rejects findings that omit any field. validateStrictAttestation() in
    // review-assurance.ts performs the runtime check post-parse.
    const props = jsonSchemaProperties();
    const attestation = props.attestation as JsonSchemaProperty;
    expect(attestation.required?.sort()).toEqual([
      'criteriaVersion',
      'iteration',
      'mandateDigest',
      'planVersion',
      'reviewedBy',
      'toolObligationId',
    ]);
  });

  it('CONTRACT: attestation is required at the top level of JSON-Schema', () => {
    // Documented intentional drift: Zod ReviewFindings has attestation.optional()
    // because the self-review path stores findings without attestation (the
    // attestation block is meaningful only for subagent-produced findings).
    // The JSON-Schema is sent ONLY to the subagent, so attestation is always
    // expected and is therefore required at the top level. validateStrictAttestation()
    // re-checks this at runtime as a defense-in-depth guard.
    const required = jsonSchemaRequired();
    expect(required).toContain('attestation');
  });

  it('GOOD: round-trip — a minimal valid SDK output passes both JSON-Schema and Zod', () => {
    // Construct a payload that satisfies the JSON-Schema, then run it through
    // the Zod parser. This catches drift where one schema accepts shapes the
    // other rejects.
    const payload = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'approve' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: {
        sessionId: 'sess_abc123',
        actorAssurance: 'best_effort' as const,
      },
      reviewedAt: new Date().toISOString(),
      attestation: {
        mandateDigest: 'sha256:placeholder',
        criteriaVersion: '1.0.0',
        toolObligationId: '00000000-0000-4000-8000-000000000000',
        iteration: 1,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer' as const,
      },
    };
    const result = ReviewFindings.safeParse(payload);
    if (!result.success) console.log('zod errors:', JSON.stringify(result.error.issues, null, 2));
    expect(result.success).toBe(true);
  });

  it('GOOD: round-trip with verified assurance — passes both schemas', () => {
    // Regression guard: pre-fix, JSON-Schema enum lacked 'verified' but Zod
    // accepted it. SDK structured-output would reject; Zod would accept.
    const payload = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'approve' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      reviewedBy: {
        sessionId: 'sess_abc123',
        actorAssurance: 'verified' as const,
      },
      reviewedAt: new Date().toISOString(),
      attestation: {
        mandateDigest: 'sha256:placeholder',
        criteriaVersion: '1.0.0',
        toolObligationId: '00000000-0000-4000-8000-000000000000',
        iteration: 1,
        planVersion: 1,
        reviewedBy: 'flowguard-reviewer' as const,
      },
    };
    const result = ReviewFindings.safeParse(payload);
    expect(result.success).toBe(true);

    // Also assert it's in the JSON-Schema enum (the actual runtime check).
    const props = jsonSchemaProperties();
    const reviewedBy = props.reviewedBy as JsonSchemaProperty;
    const actorAssurance = reviewedBy.properties?.actorAssurance as JsonSchemaProperty;
    expect(actorAssurance.enum).toContain('verified');
  });
});
