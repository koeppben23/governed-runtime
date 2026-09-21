/**
 * @module architecture/review-zone-policy
 * @description Positive zone policy for the review bounded context.
 *
 * The review bounded context is decomposed into physical zones (dispatch,
 * obligations, context, observations, evidence, validation, prompting, and the
 * review root facade). This authority freezes the directed zone graph that the
 * implementation actually requires:
 *
 *   observed zone edges === declared zone edges
 *
 * Both directions are enforced: an undeclared edge (new coupling) and a stale
 * declared edge (obsolete coupling) fail. There is no debt baseline and no
 * cycle carve-out — the declared set IS the contract, including the zone cycles
 * that the bounded context legitimately contains today. Reducing those cycles
 * through dependency inversion is a deliberate follow-up, not an implicit
 * cleanup of a structural move.
 *
 * Facade contract: `integration/review/index.ts` is the public composition
 * surface. Its outgoing edges are excluded from the zone graph (it composes
 * every zone), and production code anywhere under `src/` must never import it —
 * internal code imports the concrete authority it needs.
 *
 * The analyzer is pure: callers provide production sources, zones, and the
 * declared edge set. Test files are outside this policy.
 *
 * @version v1
 */

import { isTestSourcePath } from './module-classification.js';
import type { IntegrationPlacementZone } from './integration-placement-policy.js';

/** Public facade of the review bounded context. */
const REVIEW_FACADE_FILE = 'integration/review/index.ts';

/** Prefix of the review bounded context inside `src/`. */
const REVIEW_DIR_PREFIX = 'integration/review/';

/** A production source file (path relative to `src/` plus its content). */
export interface ReviewZoneSource {
  readonly rel: string;
  readonly content: string;
}

export interface ReviewZoneViolation {
  readonly rule: string;
  readonly file: string;
  readonly message: string;
}

export interface ReviewZoneAnalysisInput {
  readonly sources: readonly ReviewZoneSource[];
  readonly zones: readonly IntegrationPlacementZone[];
  readonly declaredEdges: ReadonlySet<string>;
}

/** `zone -> zone` identity used by the declared and observed edge sets. */
export function zoneEdgeKey(fromZone: string, toZone: string): string {
  return `${fromZone} -> ${toZone}`;
}

/** Diagnostic rendering: sorted edges, one per line. */
export function describeZoneEdges(edges: Iterable<string>): string {
  return [...edges].sort().join('\n');
}

function zoneDirOf(rel: string): string {
  return rel.split('/').slice(0, -1).join('/');
}

/** The review zone that owns a source path, or `undefined` outside review. */
function reviewZoneOf(
  rel: string,
  zoneByDir: ReadonlyMap<string, IntegrationPlacementZone>,
): string | undefined {
  const dir = zoneDirOf(rel);
  const zone = zoneByDir.get(dir);
  return zone !== undefined && (zone.id === 'review' || zone.id.startsWith('review/'))
    ? zone.id
    : undefined;
}

const MODULE_SPECIFIER_PATTERN = /(?:from|import)\s*\(?\s*["']([^"']+)["']/g;

/** Relative module specifiers (static import/export and dynamic import). */
function relativeSpecifiers(content: string): string[] {
  const out: string[] = [];
  for (const match of content.matchAll(MODULE_SPECIFIER_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.startsWith('.')) out.push(specifier);
  }
  return out;
}

/** Resolve a relative specifier against an importer to a `src/`-relative `.ts`. */
export function resolveSpecifier(importerRel: string, specifier: string): string {
  const importerDir = importerRel.split('/').slice(0, -1);
  const segments = [...importerDir, ...specifier.split('/')];
  const stack: string[] = [];
  for (const segment of segments) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') stack.pop();
    else stack.push(segment);
  }
  const joined = stack.join('/');
  if (joined.endsWith('.js')) return `${joined.slice(0, -3)}.ts`;
  if (joined.endsWith('.ts')) return joined;
  return `${joined}.ts`;
}

export function analyzeReviewZonePolicy(input: ReviewZoneAnalysisInput): ReviewZoneViolation[] {
  const violations: ReviewZoneViolation[] = [];
  const zoneByDir = new Map(input.zones.map((zone) => [zone.dir, zone]));
  const observed = new Set<string>();

  for (const source of input.sources) {
    if (isTestSourcePath(source.rel)) continue;
    for (const specifier of relativeSpecifiers(source.content)) {
      const target = resolveSpecifier(source.rel, specifier);
      if (target === REVIEW_FACADE_FILE) {
        violations.push({
          rule: 'production-facade-import',
          file: source.rel,
          message: `production code must not import the review facade (${specifier})`,
        });
        continue;
      }
      if (!target.startsWith(REVIEW_DIR_PREFIX) && target !== REVIEW_FACADE_FILE) continue;
      if (source.rel === REVIEW_FACADE_FILE) continue;
      const fromZone = reviewZoneOf(source.rel, zoneByDir);
      const toZone = reviewZoneOf(target, zoneByDir);
      if (fromZone === undefined || toZone === undefined || fromZone === toZone) continue;
      observed.add(zoneEdgeKey(fromZone, toZone));
    }
  }

  for (const edge of observed) {
    if (!input.declaredEdges.has(edge)) {
      violations.push({
        rule: 'undeclared-zone-edge',
        file: edge,
        message: 'observed review zone edge is not declared in the zone policy',
      });
    }
  }
  for (const edge of input.declaredEdges) {
    if (!observed.has(edge)) {
      violations.push({
        rule: 'stale-zone-edge',
        file: edge,
        message: 'declared review zone edge is no longer observed',
      });
    }
  }

  return violations;
}
