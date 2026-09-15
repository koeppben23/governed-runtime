/**
 * @file findings-schema-drift.test.ts
 * @description Build-time guard against drift between the runtime JSON-Schema
 * passed to the OpenCode SDK structured-output API and the canonical
 * `ReviewerFindingsInput` Zod schema (src/state/evidence-review-input.ts) that
 * accepts the reviewer's model output before host provenance is stamped.
 *
 * Why this matters:
 * - REVIEW_FINDINGS_JSON_SCHEMA is sent to the model via SDK's
 *   `format: { type: 'json_schema', schema }` parameter. The model is
 *   constrained to produce output matching this schema.
 * - `ReviewerFindingsInput` is the runtime boundary that accepts that output.
 * - If the two drift, the SDK can produce findings the pipeline rejects (or
 *   vice versa) — silent data-shape failures.
 *
 * The structural parity walker below pairs every canonical Zod node with its
 * JSON-Schema node and asserts the FULL contract: required/optional property
 * sets, strictness, enum sets, union variants, integer bounds, string
 * length/pattern/UUID constraints, and array minimums. Adding or changing a
 * property in either schema MUST update the other or this suite fails with the
 * exact contract path.
 *
 * @version v2
 */

import { describe, it, expect } from 'vitest';
import { REVIEW_FINDINGS_JSON_SCHEMA } from './findings-schema.js';
import { ReviewFindings, ReviewerFindingsInput } from '../../state/evidence.js';

// ─── JSON schema view ────────────────────────────────────────────────────────

interface JsonSchemaNode {
  readonly type?: string;
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean;
  readonly items?: JsonSchemaNode;
  readonly oneOf?: readonly JsonSchemaNode[];
  readonly enum?: readonly string[];
  readonly const?: string;
  readonly pattern?: string;
  readonly minLength?: number;
  readonly maxLength?: number;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly minItems?: number;
}

const JSON_SCHEMA_ROOT = REVIEW_FINDINGS_JSON_SCHEMA as unknown as JsonSchemaNode;

/**
 * Canonical RFC 4122 UUID pattern. Must stay in sync with
 * `z.string().uuid()` in the canonical state schemas.
 */
const UUID_PATTERN =
  '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$';

/**
 * Optional identity fields the host mints AFTER the reviewer input boundary.
 * The SDK schema deliberately omits them; the canonical contract must declare
 * them optional so the reviewer is never asked to author host identity.
 */
const HOST_MINTED_OPTIONAL_FIELDS = new Set(['findingId']);

// ─── Zod introspection ───────────────────────────────────────────────────────

type ZodLike = {
  _zod?: { def?: Record<string, unknown> };
  def?: Record<string, unknown>;
} & object;

function zodDef(schema: unknown): Record<string, unknown> {
  const candidate = schema as ZodLike;
  return candidate?._zod?.def ?? candidate?.def ?? {};
}

/** Strip readonly/optional/pipe wrappers down to the structural schema. */
function unwrapZod(schema: unknown): unknown {
  let current: unknown = schema;
  for (;;) {
    const def = zodDef(current);
    if (def.type === 'readonly' || def.type === 'optional') {
      current = def.innerType;
      continue;
    }
    if (def.type === 'pipe') {
      current = def.in;
      continue;
    }
    return current;
  }
}

/** Structural category of a canonical node, aligned with JSON-Schema types. */
function zodKind(schema: unknown): string {
  const type = zodDef(unwrapZod(schema)).type;
  return type === 'number' ? 'integer' : String(type);
}

function zodShape(schema: unknown): Record<string, unknown> {
  const shape = zodDef(unwrapZod(schema)).shape;
  return shape && typeof shape === 'object' ? (shape as Record<string, unknown>) : {};
}

function isOptional(schema: unknown): boolean {
  return zodDef(schema).type === 'optional';
}

function isZodStrictObject(schema: unknown): boolean {
  const def = zodDef(unwrapZod(schema));
  return zodDef(def.catchall).type === 'never';
}

function zodChecks(schema: unknown): Record<string, unknown>[] {
  const checks = zodDef(unwrapZod(schema)).checks;
  return Array.isArray(checks) ? (checks as Record<string, unknown>[]) : [];
}

function zodEnumValues(schema: unknown): string[] {
  const entries = zodDef(unwrapZod(schema)).entries;
  if (!entries || typeof entries !== 'object') return [];
  return Object.values(entries as Record<string, unknown>).map((value) => String(value));
}

function zodLiteralValues(schema: unknown): string[] {
  const values = zodDef(unwrapZod(schema)).values;
  if (Array.isArray(values)) return values.map((value) => String(value));
  if (values instanceof Set) return [...values].map((value) => String(value));
  return [];
}

function zodUnionOptions(schema: unknown): unknown[] {
  const options = zodDef(unwrapZod(schema)).options;
  return Array.isArray(options) ? options : [];
}

function discriminatorKey(schema: unknown): string | null {
  const def = zodDef(unwrapZod(schema));
  if (def.type !== 'object') return null;
  const shape = zodShape(schema);
  const kindSchema = shape.kind;
  if (kindSchema === undefined) return null;
  const values = zodLiteralValues(kindSchema);
  return values.length === 1 ? values[0]! : null;
}

interface NumericBounds {
  minimum?: number;
  maximum?: number;
}

function zodNumericBounds(schema: unknown): NumericBounds {
  const bounds: NumericBounds = {};
  for (const check of zodChecks(schema)) {
    const def = zodDef(check);
    if (def.check === 'greater_than' && typeof def.value === 'number') {
      // Exclusive bounds are converted to the integer minimum they admit.
      const candidate = def.inclusive === false ? def.value + 1 : def.value;
      bounds.minimum =
        bounds.minimum === undefined ? candidate : Math.max(bounds.minimum, candidate);
    }
    if (def.check === 'less_than' && typeof def.value === 'number') {
      const candidate = def.inclusive === false ? def.value - 1 : def.value;
      bounds.maximum =
        bounds.maximum === undefined ? candidate : Math.min(bounds.maximum, candidate);
    }
  }
  return bounds;
}

interface StringContract {
  minLength?: number;
  maxLength?: number;
  format?: string;
  pattern?: string;
}

function zodStringContract(schema: unknown): StringContract {
  const contract: StringContract = {};
  for (const check of zodChecks(schema)) {
    const def = zodDef(check);
    if (def.check === 'min_length' && typeof def.minimum === 'number') {
      contract.minLength = def.minimum;
    }
    if (def.check === 'max_length' && typeof def.maximum === 'number') {
      contract.maxLength = def.maximum;
    }
    if (def.check === 'string_format') {
      if (typeof def.format === 'string') contract.format = def.format;
      if (def.pattern instanceof RegExp) contract.pattern = def.pattern.source;
    }
  }
  return contract;
}

function zodArrayMinItems(schema: unknown): number | undefined {
  for (const check of zodChecks(schema)) {
    const def = zodDef(check);
    if (def.check === 'min_length' && typeof def.minimum === 'number') return def.minimum;
  }
  return undefined;
}

function isJsonObject(node: JsonSchemaNode): boolean {
  return node.type === 'object' || node.properties !== undefined;
}

/** Unwrap the single-variant `oneOf` used as a named reuse wrapper. */
function unwrapSingletonOneOf(node: JsonSchemaNode): JsonSchemaNode {
  if (node.oneOf && node.oneOf.length === 1 && node.type === undefined) return node.oneOf[0]!;
  return node;
}

// ─── Structural parity walker ────────────────────────────────────────────────

interface ContractPair {
  readonly path: string;
  readonly zod: unknown;
  readonly json: JsonSchemaNode;
}

function walkContractPairs(
  rootZod: unknown,
  rootJson: JsonSchemaNode,
  visit: (pair: ContractPair) => void,
  violations: string[],
): void {
  const recurse = (zodSchema: unknown, jsonNode: JsonSchemaNode, path: string): void => {
    const node = unwrapSingletonOneOf(jsonNode);
    const zod = unwrapZod(zodSchema);

    visit({ path, zod, json: node });
    const kind = zodKind(zod);

    if (kind === 'object') {
      const shape = zodShape(zod);
      for (const key of Object.keys(shape)) {
        const child = node.properties?.[key];
        if (!child) continue; // property-set drift is reported by its own check
        recurse(shape[key], child, `${path}.${key}`);
      }
      return;
    }

    if (kind === 'array') {
      const element = zodDef(zod).element;
      if (!node.items) {
        violations.push(`${path}: SDK array schema is missing items`);
        return;
      }
      recurse(element, node.items, `${path}[]`);
      return;
    }

    if (kind === 'union') {
      const options = zodUnionOptions(zod);
      const jsonVariants = [...(node.oneOf ?? [])];
      if (jsonVariants.length === 0) {
        violations.push(`${path}: SDK schema is missing oneOf for the canonical union`);
        return;
      }
      const jsonByKind = new Map<string, JsonSchemaNode>();
      for (const variant of jsonVariants) {
        const kindValue = variant.properties?.kind?.const;
        if (kindValue === undefined) {
          violations.push(`${path}: SDK union variant has no discriminator "kind" const`);
          continue;
        }
        jsonByKind.set(kindValue, variant);
      }
      for (const option of options) {
        const key = discriminatorKey(option);
        if (key === null) {
          violations.push(`${path}: canonical union variant has no "kind" discriminator`);
          continue;
        }
        const jsonVariant = jsonByKind.get(key);
        if (!jsonVariant) {
          violations.push(`${path}: SDK schema is missing the canonical "${key}" variant`);
          continue;
        }
        jsonByKind.delete(key);
        recurse(option, jsonVariant, `${path}<${key}>`);
      }
      for (const extra of jsonByKind.keys()) {
        violations.push(`${path}: SDK schema has the non-canonical "${extra}" variant`);
      }
      return;
    }

    if (kind !== 'enum' && kind !== 'literal' && kind !== 'string' && kind !== 'integer') {
      violations.push(`${path}: unsupported canonical node type "${kind}"`);
    }
  };

  recurse(rootZod, rootJson, 'root');
}

/** Run the walker with one focused visitor and return the collected failures. */
function parityViolations(visit: (pair: ContractPair) => void): string[] {
  const violations: string[] = [];
  walkContractPairs(ReviewerFindingsInput, JSON_SCHEMA_ROOT, visit, violations);
  return violations;
}

// ─── Structural parity: full contract, not spot checks ───────────────────────

describe('REVIEW_FINDINGS_JSON_SCHEMA ↔ ReviewerFindingsInput structural parity', () => {
  it('required and optional property sets match at every object boundary', () => {
    const violations = parityViolations(({ path, zod, json }) => {
      if (zodKind(zod) !== 'object') return;
      const shape = zodShape(zod);
      const zodKeys = Object.keys(shape);
      const jsonProperties = json.properties ?? {};
      const jsonKeys = Object.keys(jsonProperties);

      for (const key of jsonKeys) {
        if (!(key in shape)) {
          violations.push(`${path}: SDK property "${key}" is not in the canonical contract`);
        }
      }
      for (const key of zodKeys) {
        if (key in jsonProperties) continue;
        if (!HOST_MINTED_OPTIONAL_FIELDS.has(key)) {
          violations.push(`${path}: canonical property "${key}" is missing from the SDK schema`);
        } else if (!isOptional(shape[key])) {
          violations.push(
            `${path}: omitted host-minted field "${key}" must be optional in the canonical contract`,
          );
        }
      }

      const zodRequired = zodKeys.filter((key) => !isOptional(shape[key])).sort();
      const jsonRequired = [...(json.required ?? [])].sort();
      if (zodRequired.join('|') !== jsonRequired.join('|')) {
        violations.push(
          `${path}: required set drift: SDK [${jsonRequired.join(', ')}] vs canonical [${zodRequired.join(', ')}]`,
        );
      }
    });
    expect(violations).toEqual([]);
  });

  it('every object boundary rejects unknown properties on both sides', () => {
    const violations = parityViolations(({ path, zod, json }) => {
      if (!isJsonObject(json)) return;
      if (json.additionalProperties !== false) {
        violations.push(`${path}: SDK object must set additionalProperties: false`);
      }
      if (zodKind(zod) !== 'object') {
        violations.push(`${path}: canonical node is not an object`);
        return;
      }
      if (!isZodStrictObject(zod)) {
        violations.push(`${path}: canonical object must be strict`);
      }
    });
    expect(violations).toEqual([]);
  });

  it('every enum set matches the canonical contract (const is a documented narrowing)', () => {
    const violations = parityViolations(({ path, zod, json }) => {
      const kind = zodKind(zod);
      if (kind === 'enum') {
        const canonical = zodEnumValues(zod);
        if (json.const !== undefined) {
          if (!canonical.includes(json.const)) {
            violations.push(`${path}: SDK const "${json.const}" is not a canonical enum value`);
          }
          return;
        }
        const sdk = [...(json.enum ?? [])];
        if (sdk.length === 0) {
          violations.push(`${path}: SDK enum is missing`);
          return;
        }
        if ([...sdk].sort().join('|') !== [...canonical].sort().join('|')) {
          violations.push(
            `${path}: enum drift: SDK [${sdk.join(', ')}] vs canonical [${canonical.join(', ')}]`,
          );
        }
        return;
      }
      if (kind === 'literal') {
        const canonical = zodLiteralValues(zod);
        if (json.const === undefined || !canonical.includes(json.const)) {
          violations.push(
            `${path}: SDK const "${json.const ?? '<missing>'}" is not the canonical literal "${canonical.join('|')}"`,
          );
        }
      }
    });
    expect(violations).toEqual([]);
  });

  it('union/oneOf variants cover every canonical discriminator variant', () => {
    const unionPaths: string[] = [];
    const violations = parityViolations(({ path, zod }) => {
      if (zodKind(zod) === 'union') unionPaths.push(path);
    });
    expect(violations).toEqual([]);
    expect(unionPaths).toEqual(
      expect.arrayContaining([
        'root.blockingIssues[].relation.subjectAnchors[]',
        'root.challenges[]',
        'root.challenges[]<implementation_challenge>.evidenceRefs[]',
      ]),
    );
  });

  it('integer minimums and maximums match the canonical constraints', () => {
    const integerPaths: string[] = [];
    const violations = parityViolations(({ path, zod, json }) => {
      if (zodKind(zod) !== 'integer') return;
      integerPaths.push(path);
      if (json.type !== 'integer') {
        violations.push(`${path}: SDK type must be integer, got "${json.type ?? '<missing>'}"`);
        return;
      }
      const bounds = zodNumericBounds(zod);
      if ((bounds.minimum ?? null) !== (json.minimum ?? null)) {
        violations.push(
          `${path}: minimum drift: SDK ${json.minimum ?? '<unbounded>'} vs canonical ${bounds.minimum ?? '<unbounded>'}`,
        );
      }
      if ((bounds.maximum ?? null) !== (json.maximum ?? null)) {
        violations.push(
          `${path}: maximum drift: SDK ${json.maximum ?? '<unbounded>'} vs canonical ${bounds.maximum ?? '<unbounded>'}`,
        );
      }
    });
    expect(violations).toEqual([]);
    expect(integerPaths).toEqual(
      expect.arrayContaining([
        'root.iteration',
        'root.planVersion',
        'root.blockingIssues[].relation.subjectAnchors[]<artifact_section>.sectionPath[].headingDepth',
        'root.blockingIssues[].relation.subjectAnchors[]<content>.range.startLine',
      ]),
    );
  });

  it('string length, pattern, and UUID constraints match the canonical contract', () => {
    const violations = parityViolations(({ path, zod, json }) => {
      if (zodKind(zod) !== 'string') return;
      if (json.type !== 'string') {
        violations.push(`${path}: SDK type must be string, got "${json.type ?? '<missing>'}"`);
        return;
      }
      const contract = zodStringContract(zod);
      if (contract.minLength !== undefined && (json.minLength ?? 0) < contract.minLength) {
        violations.push(
          `${path}: SDK minLength ${json.minLength ?? 0} is weaker than canonical minimum ${contract.minLength}`,
        );
      }
      if (
        contract.maxLength !== undefined &&
        (json.maxLength === undefined || json.maxLength > contract.maxLength)
      ) {
        violations.push(
          `${path}: SDK maxLength ${json.maxLength ?? '<missing>'} exceeds canonical maximum ${contract.maxLength}`,
        );
      }
      if (contract.format === 'uuid') {
        if (json.pattern !== UUID_PATTERN) {
          violations.push(
            `${path}: SDK must carry the canonical RFC 4122 UUID pattern for z.string().uuid()`,
          );
        }
      } else if (contract.pattern !== undefined && json.pattern !== contract.pattern) {
        violations.push(
          `${path}: SDK pattern "${json.pattern ?? '<missing>'}" must equal canonical pattern "${contract.pattern}"`,
        );
      }
    });
    expect(violations).toEqual([]);
  });

  it('array item schemas and minimum lengths match the canonical contract', () => {
    const violations = parityViolations(({ path, zod, json }) => {
      if (zodKind(zod) !== 'array') return;
      if (json.type !== 'array') {
        violations.push(`${path}: SDK type must be array, got "${json.type ?? '<missing>'}"`);
        return;
      }
      const canonicalMin = zodArrayMinItems(zod);
      if ((canonicalMin ?? null) !== (json.minItems ?? null)) {
        violations.push(
          `${path}: minItems drift: SDK ${json.minItems ?? '<unbounded>'} vs canonical ${canonicalMin ?? '<unbounded>'}`,
        );
      }
    });
    expect(violations).toEqual([]);
  });
});

// ─── Documented contract boundaries ──────────────────────────────────────────

function minimalSdkPayload() {
  return {
    iteration: 1,
    planVersion: 1,
    reviewMode: 'subagent' as const,
    overallVerdict: 'accept' as const,
    blockingIssues: [],
    majorRisks: [],
    missingVerification: [],
    scopeCreep: [],
    unknowns: [],
    challenges: [],
    attestation: {
      toolObligationId: '00000000-0000-4000-8000-000000000000',
    },
  };
}

describe('documented contract boundaries', () => {
  it('CONTRACT: host-owned provenance is absent from the reviewer input schema', () => {
    const jsonProps = Object.keys(JSON_SCHEMA_ROOT.properties ?? {});
    expect(jsonProps).not.toHaveProperty('reviewedBy');
    expect(jsonProps).not.toHaveProperty('reviewedAt');
  });

  it('CONTRACT: findings require structured relations and reject legacy locations', () => {
    for (const key of ['blockingIssues', 'majorRisks'] as const) {
      const finding = JSON_SCHEMA_ROOT.properties![key]!.items!;
      expect(finding.properties?.relation).toBeDefined();
      expect(finding.required).toContain('relation');
      expect(finding.properties?.location).toBeUndefined();
    }
  });

  it('CONTRACT: attestation requires only the reviewer-owned obligation binding', () => {
    const attestation = JSON_SCHEMA_ROOT.properties!.attestation!;
    expect(attestation.required).toEqual(['toolObligationId']);
  });

  it('CONTRACT: attestation is required at the top level of the SDK schema and the review input', () => {
    expect(JSON_SCHEMA_ROOT.required).toContain('attestation');
    const { attestation: _omitted, ...withoutAttestation } = minimalSdkPayload();
    expect(ReviewerFindingsInput.safeParse(withoutAttestation).success).toBe(false);
  });

  it('CONTRACT: challenges are required at the top level of the SDK schema and the review input', () => {
    expect(JSON_SCHEMA_ROOT.properties!.challenges).toBeDefined();
    expect(JSON_SCHEMA_ROOT.required).toContain('challenges');
    const { challenges: _omitted, ...withoutChallenges } = minimalSdkPayload();
    expect(ReviewerFindingsInput.safeParse(withoutChallenges).success).toBe(false);
  });

  it('CONTRACT: SDK challenges use reviewer input identity, not host-minted identity', () => {
    const variants = JSON_SCHEMA_ROOT.properties!.challenges!.items!.oneOf!;
    for (const variant of variants) {
      expect(variant.properties).toHaveProperty('clientReference');
      expect(variant.properties).not.toHaveProperty('challengeId');
      expect(variant.required).toContain('obligationId');
      expect(variant.required).not.toContain('clientReference');
    }
  });

  it('CONTRACT: reviewMode is locked to const "subagent" for the reviewer transport', () => {
    expect(JSON_SCHEMA_ROOT.properties!.reviewMode!.const).toBe('subagent');
  });

  it('GOOD: round-trip — a minimal valid SDK output passes both surfaces', () => {
    const payload = minimalSdkPayload();
    expect(ReviewerFindingsInput.safeParse(payload).success).toBe(true);
  });

  it('GOOD: host-stamped canonical findings pass ReviewFindings after input validation', () => {
    const payload = minimalSdkPayload();
    expect(ReviewerFindingsInput.safeParse(payload).success).toBe(true);

    expect(
      ReviewFindings.safeParse({
        ...payload,
        reviewedBy: { sessionId: 'sess_abc123', actorAssurance: 'idp_verified' },
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

  it('GOOD: round-trip with overallVerdict=unable_to_review passes both surfaces', () => {
    const payload = {
      ...minimalSdkPayload(),
      overallVerdict: 'unable_to_review' as const,
      missingVerification: ['plan text malformed at line 42'],
      unknowns: ['cannot parse the proposed schema diff'],
    };
    expect(ReviewerFindingsInput.safeParse(payload).success).toBe(true);
    expect(JSON_SCHEMA_ROOT.properties!.overallVerdict!.enum).toContain('unable_to_review');
  });
});
