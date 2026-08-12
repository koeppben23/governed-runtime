/**
 * @module integration/review/schema-introspect
 * @description Derives JSON-schema-compatible enum values from canonical Zod
 * types at module initialization. No hand-written enum copy can drift from
 * the Zod gate — every value is sourced from the canonical schema tree.
 *
 * `z.toJSONSchema()` is not used here because the canonical types contain Zod
 * transforms (RepositoryPathSchema.transform) which cannot be represented in
 * JSON Schema. This module instead extracts enum members and discriminator
 * variant identifiers from the Zod _def tree.
 */

import { Finding, ReviewSubjectAnchor } from '../../state/evidence-findings.js';
import { ReviewChallenge } from '../../state/evidence-review.js';

function zodEnumValues(schema: unknown, fallback: readonly string[]): readonly string[] {
  if (!schema) return fallback;
  const def = (schema as Record<string, unknown>)._zod as
    { def: { values: readonly string[] } } | undefined;
  if (def?.def?.values) return def.def.values;
  const legacy = (schema as Record<string, unknown>)._def as
    { values: readonly string[] } | undefined;
  if (legacy?.values) return legacy.values;
  return fallback;
}

function intoShape(schema: unknown): Record<string, unknown> | undefined {
  return (schema as { _zod?: { def?: { shape?: Record<string, unknown> } } })?._zod?.def?.shape;
}

// eslint-disable-next-line complexity
function zodDiscriminatedVariants(schema: unknown): readonly string[] {
  const def = (schema as Record<string, unknown>)?._zod as
    { def: { options: readonly Record<string, unknown>[] } } | undefined;
  const options = def?.def?.options ?? [];
  const variants: string[] = [];
  for (const opt of options) {
    const shape = (
      opt as {
        _zod?: { def?: { shape?: Record<string, { _zod?: { def?: { value?: string } } }> } };
      }
    )._zod?.def?.shape;
    const kind = shape?.kind?._zod?.def?.value;
    if (typeof kind === 'string') variants.push(kind);
  }
  return variants;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const findingShape: Record<string, any> | undefined = intoShape(Finding);

export const CANONICAL_SEVERITIES = zodEnumValues(findingShape?.severity, [
  'critical',
  'major',
  'minor',
]);

export const CANONICAL_CATEGORIES = zodEnumValues(findingShape?.category, [
  'completeness',
  'correctness',
  'feasibility',
  'risk',
  'quality',
]);

export const CANONICAL_ANCHOR_KINDS = zodDiscriminatedVariants(ReviewSubjectAnchor);

export const CANONICAL_CHALLENGE_KINDS = zodDiscriminatedVariants(ReviewChallenge);
