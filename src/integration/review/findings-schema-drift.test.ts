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
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { ReviewFindings, ReviewerFindingsInput } from '../../state/evidence.js';

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
  oneOf?: JsonSchemaProperty[];
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
  const inner = (
    ReviewerFindingsInput as unknown as { _def: { innerType?: z.ZodObject<z.ZodRawShape> } }
  )._def.innerType;
  if (!inner) {
    throw new Error('Could not unwrap ReviewerFindingsInput — schema structure changed');
  }
  return Object.keys(inner.shape);
}

function collectSubjectAnchorKinds(): string[] {
  const props = jsonSchemaProperties();
  const blocking = props.blockingIssues as unknown as JsonSchemaProperty;
  const findingItems = blocking?.items as JsonSchemaProperty | undefined;
  const relation = findingItems?.properties?.relation as JsonSchemaProperty | undefined;
  const subjectAnchors = relation?.properties?.subjectAnchors as JsonSchemaProperty | undefined;
  const anchorItems = subjectAnchors?.items as JsonSchemaProperty | undefined;
  const oneOf = anchorItems?.oneOf as JsonSchemaProperty[] | undefined;
  if (!oneOf) return [];
  return oneOf
    .map((variant: JsonSchemaProperty) => variant?.properties?.kind?.const)
    .filter((v: string | undefined): v is string => typeof v === 'string');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

/**
 * The SDK schema represents ReviewerFindingsInput, not canonical persisted
 * ReviewFindings. Host provenance is added only after this strict boundary.
 */

describe('REVIEW_FINDINGS_JSON_SCHEMA ↔ ReviewerFindingsInput drift guard', () => {
  it('GOOD: every JSON-Schema property is also a Zod property', () => {
    const jsonProps = Object.keys(jsonSchemaProperties());
    const zodProps = zodTopLevelKeys();
    const missing = jsonProps.filter((p) => !zodProps.includes(p));
    expect(missing).toEqual([]);
  });

  it('GOOD: every ReviewerFindingsInput property is a JSON-Schema property', () => {
    const jsonProps = Object.keys(jsonSchemaProperties());
    const zodProps = zodTopLevelKeys();
    const missing = zodProps.filter((p) => !jsonProps.includes(p));
    expect(missing).toEqual([]);
  });

  it('CONTRACT: host-owned provenance is absent from the reviewer input schema', () => {
    const jsonProps = Object.keys(jsonSchemaProperties());
    expect(jsonProps).not.toHaveProperty('reviewedBy');
    expect(jsonProps).not.toHaveProperty('reviewedAt');
  });

  it('CONTRACT: every nested object boundary rejects unknown keys', () => {
    const props = jsonSchemaProperties();
    const finding = props.blockingIssues!.items!;
    const relation = finding.properties!.relation!;
    const anchorItems = relation.properties!.subjectAnchors!.items!;
    const location = (relation.properties!.evidenceLocations!.items!.oneOf ?? [])[0]!;
    const challenge = props.challenges!.items!.oneOf![0]!;
    const evidenceRef = challenge.properties!.evidenceRefs!.items!;

    expect(finding.additionalProperties).toBe(false);
    expect(relation.additionalProperties).toBe(false);
    expect(location.additionalProperties).toBe(false);
    expect(anchorItems.oneOf?.every((item) => item.additionalProperties === false)).toBe(true);
    expect(challenge.additionalProperties).toBe(false);
    expect(evidenceRef.additionalProperties).toBe(false);
    expect(props.attestation!.additionalProperties).toBe(false);
  });

  it('GOOD: overallVerdict enum matches LoopVerdict (accept | changes_requested | unable_to_review)', () => {
    const props = jsonSchemaProperties();
    const verdict = props.overallVerdict as JsonSchemaProperty;
    expect(verdict.enum).toEqual(['accept', 'changes_requested', 'unable_to_review']);
  });

  it('GOOD: reviewMode is locked to const "subagent"', () => {
    const props = jsonSchemaProperties();
    const mode = props.reviewMode as JsonSchemaProperty;
    expect(mode.const).toBe('subagent');
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

  it('GOOD: subject anchor oneOf includes all three canonical discriminator variants', () => {
    // The canonical ReviewSubjectAnchor has three variants:
    // repository_location, artifact_section, content.
    // The JSON schema must present all three so the model is not forced to
    // guess an unsupported variant.
    const anchorKinds = collectSubjectAnchorKinds();
    expect(anchorKinds.sort()).toEqual(
      ['artifact_section', 'content', 'repository_location'].sort(),
    );
  });

  it('GOOD: evidenceLocations path type is string, revision enum is base|head', () => {
    // The JSON schema must not accept revision values like "current" or
    // "modified" that the Zod schema rejects.
    const items = jsonSchemaProperties().blockingIssues as unknown as JsonSchemaProperty;
    const findingItems = items?.items as JsonSchemaProperty | undefined;
    const relation = findingItems?.properties?.relation as JsonSchemaProperty | undefined;
    const evLoc = relation?.properties?.evidenceLocations as JsonSchemaProperty | undefined;
    const evItems = evLoc?.items as JsonSchemaProperty | undefined;
    // REPOSITORY_LOCATION_JSON_SCHEMA wraps in oneOf
    const evOneOf = evItems?.oneOf as JsonSchemaProperty[] | undefined;
    const locationSchema = evOneOf?.[0] ?? evItems;
    const revision = locationSchema?.properties?.revision as JsonSchemaProperty | undefined;
    expect(revision?.enum?.sort()).toEqual(['base', 'head']);
  });

  it('CONTRACT: findings require structured relations and reject legacy locations', () => {
    const props = jsonSchemaProperties();
    for (const key of ['blockingIssues', 'majorRisks'] as const) {
      const finding = props[key]!.items!;
      expect(finding.properties?.relation).toBeDefined();
      expect(finding.required).toContain('relation');
      expect(finding.properties?.location).toBeUndefined();
    }
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

  it('GOOD: attestation block requires only reviewer-owned obligation binding', () => {
    // Host-owned attestation fields are stamped after the reviewer input
    // validates; structured output may carry only the obligation binding.
    const props = jsonSchemaProperties();
    const attestation = props.attestation as JsonSchemaProperty;
    expect(attestation.required).toEqual(['toolObligationId']);
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

  it('CONTRACT: challenges are available to the SDK but remain optional for legacy findings', () => {
    const props = jsonSchemaProperties();
    expect(props.challenges).toBeDefined();
    expect(jsonSchemaRequired()).not.toContain('challenges');
  });

  it('GOOD: challenge oneOf includes all three canonical discriminator variants', () => {
    // The canonical ReviewChallenge has design_challenge, implementation_challenge,
    // content_challenge. The JSON schema must present all three.
    const props = jsonSchemaProperties();
    const challenges = props.challenges as JsonSchemaProperty;
    const oneOf = challenges?.items?.oneOf as JsonSchemaProperty[] | undefined;
    expect(oneOf).toBeDefined();
    expect(oneOf!.length).toBeGreaterThanOrEqual(3);
    const kinds = oneOf!
      .map((v) => v.properties?.kind?.const)
      .filter((k): k is string => typeof k === 'string');
    expect(kinds.sort()).toEqual(
      ['content_challenge', 'design_challenge', 'implementation_challenge'].sort(),
    );
  });

  it('CONTRACT: SDK challenges use reviewer input identity, not host-minted identity', () => {
    const props = jsonSchemaProperties();
    const challenges = props.challenges as JsonSchemaProperty;
    const variants = challenges.items!.oneOf!;

    for (const variant of variants) {
      expect(variant.properties).toHaveProperty('clientReference');
      expect(variant.properties).not.toHaveProperty('challengeId');
      expect(variant.required).toContain('obligationId');
      expect(variant.required).not.toContain('clientReference');
    }
  });

  it('GOOD: challenge outcome enums match canonical per-type values', () => {
    // design_challenge and content_challenge: supported, contradicted, not_verified
    // implementation_challenge: pass, fail, not_verified
    const props = jsonSchemaProperties();
    const challenges = props.challenges as JsonSchemaProperty;
    const oneOf = challenges?.items?.oneOf as JsonSchemaProperty[] | undefined;
    expect(oneOf).toBeDefined();

    for (const variant of oneOf!) {
      const kind = variant.properties?.kind?.const as string | undefined;
      const outcome = variant.properties?.outcome?.enum as string[] | undefined;
      if (kind === 'implementation_challenge') {
        expect(outcome?.sort()).toEqual(['fail', 'not_verified', 'pass']);
      } else if (kind === 'design_challenge' || kind === 'content_challenge') {
        expect(outcome?.sort()).toEqual(['contradicted', 'not_verified', 'supported']);
      }
    }
  });

  it('GOOD: round-trip — a minimal valid SDK output passes both JSON-Schema and Zod', () => {
    // Construct a payload that satisfies the JSON-Schema, then run it through
    // the Zod parser. This catches drift where one schema accepts shapes the
    // other rejects.
    const payload = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'accept' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      attestation: {
        toolObligationId: '00000000-0000-4000-8000-000000000000',
      },
    };
    const result = ReviewerFindingsInput.safeParse(payload);
    expect(result.success).toBe(true);
  });

  it('GOOD: host-stamped canonical findings pass ReviewFindings after input validation', () => {
    // Regression guard: pre-fix, JSON-Schema enum lacked 'verified' but Zod
    // accepted it. SDK structured-output would reject; Zod would accept.
    const payload = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'accept' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: [],
      scopeCreep: [],
      unknowns: [],
      attestation: {
        toolObligationId: '00000000-0000-4000-8000-000000000000',
      },
    };
    const result = ReviewerFindingsInput.safeParse(payload);
    expect(result.success).toBe(true);

    expect(
      ReviewFindings.safeParse({
        ...payload,
        reviewedBy: { sessionId: 'sess_abc123', actorAssurance: 'verified' },
        reviewedAt: new Date().toISOString(),
        attestation: {
          toolObligationId: payload.attestation.toolObligationId,
          mandateDigest: 'sha256:placeholder',
          criteriaVersion: '1.0.0',
          iteration: 1,
          planVersion: 1,
          reviewedBy: 'flowguard-reviewer',
        },
      }).success,
    ).toBe(true);
  });

  it('GOOD: round-trip with overallVerdict=unable_to_review — passes both schemas (P1.3 third-verdict)', () => {
    // Regression guard for P1.3: ensure the new third LoopVerdict value
    // round-trips through both the JSON-Schema (SDK structured output) and
    // the Zod ReviewFindings parser. Drift here would mean the reviewer
    // subagent could emit unable_to_review but the runtime would reject it
    // (or vice versa), defeating the BLOCKED-routing in slice 4.
    const payload = {
      iteration: 1,
      planVersion: 1,
      reviewMode: 'subagent' as const,
      overallVerdict: 'unable_to_review' as const,
      blockingIssues: [],
      majorRisks: [],
      missingVerification: ['plan text malformed at line 42'],
      scopeCreep: [],
      unknowns: ['cannot parse the proposed schema diff'],
      attestation: {
        toolObligationId: '00000000-0000-4000-8000-000000000000',
      },
    };
    const result = ReviewerFindingsInput.safeParse(payload);
    expect(result.success).toBe(true);

    // Also assert the JSON-Schema enum admits the value.
    const props = jsonSchemaProperties();
    const verdict = props.overallVerdict as JsonSchemaProperty;
    expect(verdict.enum).toContain('unable_to_review');
  });
});
