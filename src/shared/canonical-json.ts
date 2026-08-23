/**
 * @module shared/canonical-json
 * @description The single canonical JSON serialization authority.
 *
 * Produces a deterministic JSON string for any JSON-compatible value by sorting
 * object keys lexicographically at every depth (arrays keep order — order is
 * semantic). Two structurally equal values always serialize to identical
 * strings regardless of original key insertion order.
 *
 * This is the ONE place a recursive key-sorting JSON serializer may be defined.
 * Audit digests/chain hashes and discovery digests both route through it, so
 * there is no risk of two divergent serializers silently producing different
 * digests (the #434 C1 defect class). Enforced by
 * `architecture/__tests__/audit-canonicalization-ssot.test.ts`.
 *
 * Note on `undefined`: object properties whose value is `undefined` are dropped
 * before serialization (JSON.stringify drops them anyway); `undefined` and
 * sparse array elements become `null` (standard JSON.stringify behaviour).
 * Both rules are applied consistently here.
 *
 * @version v1
 */

/**
 * Recursively produce a canonical form of a JSON-compatible value: object keys
 * sorted at every depth, arrays preserved in order, primitives unchanged.
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!value || typeof value !== 'object') return value;

  const record = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const nested = record[key];
    if (nested !== undefined) sorted[key] = canonicalize(nested);
  }
  return sorted;
}

/**
 * Serialize JSON-compatible values with object keys sorted at every depth.
 * Deterministic: structurally equal inputs yield byte-identical output.
 */
export function canonicalJsonStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}
