import { canonicalJsonStringify } from '../../shared/canonical-json.js';
import { hashText } from '../../shared/hashing.js';

export function hashFindings(findings: Record<string, unknown>): string {
  const normalizeFinding = (value: unknown): unknown => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const finding = value as Record<string, unknown>;
    const { findingId: _findingId, relation, ...rest } = finding;
    if (!relation || typeof relation !== 'object' || Array.isArray(relation)) return rest;
    const typedRelation = relation as Record<string, unknown>;
    const sorted = (items: unknown) =>
      Array.isArray(items)
        ? [...items].sort((left, right) =>
            canonicalJsonStringify(left).localeCompare(canonicalJsonStringify(right)),
          )
        : items;
    return {
      ...rest,
      relation: {
        ...typedRelation,
        subjectAnchors: sorted(typedRelation.subjectAnchors),
        evidenceLocations: sorted(typedRelation.evidenceLocations),
      },
    };
  };
  return hashText(
    canonicalJsonStringify({
      ...findings,
      blockingIssues: Array.isArray(findings.blockingIssues)
        ? findings.blockingIssues.map(normalizeFinding)
        : findings.blockingIssues,
      majorRisks: Array.isArray(findings.majorRisks)
        ? findings.majorRisks.map(normalizeFinding)
        : findings.majorRisks,
    }),
  );
}
