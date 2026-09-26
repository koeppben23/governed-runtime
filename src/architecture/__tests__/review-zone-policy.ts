/**
 * @module architecture/review-zone-policy
 * @description Positive zone policy for the review bounded context.
 *
 * The review bounded context is decomposed into physical zones (dispatch,
 * obligations, context, observations, evidence, validation, prompting, and the
 * review root). This authority freezes the directed zone graph that the
 * implementation actually requires:
 *
 *   observed zone edges === declared zone edges
 *
 * Both directions are enforced: an undeclared edge (new coupling) and a stale
 * declared edge (obsolete coupling) fail. There is no debt baseline and no
 * cycle carve-out — the declared set IS the contract.
 *
 * Graph shape: the review zone graph must be fully acyclic. Direct mutual zone
 * pairs and longer strongly connected components are both rejected by the
 * real-tree policy test through `reviewZoneCycles`.
 *
 * No-barrel contract: the bounded context has no `review/index.ts` facade
 * (removed as redundant in ADR-005); the review root keeps only cross-zone
 * primitives, and subzones carry no barrels. The `dependency-rules.test.ts`
 * guard fails if a barrel reappears.
 *
 * The analyzer is pure: callers provide production sources, zones, and the
 * declared edge set. Test files are outside this policy.
 *
 * @version v2
 */

import { isTestSourcePath } from './module-classification.js';
import { collectImportSpecifiers } from './import-specifiers.js';
import type { IntegrationPlacementZone } from './integration-placement-policy.js';
import { stronglyConnectedComponents, type ModuleEdge } from './module-graph.js';

/** Prefix of the review bounded context inside `src/`. */
const REVIEW_DIR_PREFIX = 'integration/review/';

/** A production source file (path relative to `src/` plus its content). */
export interface ReviewZoneSource {
  readonly rel: string;
  readonly content: string;
}

/**
 * The review zone graph the decomposition requires, measured on the final
 * tree. This is a set, not a count: a new edge fails until it is declared, and
 * a declared edge that stops being observed fails as stale. Zone acyclicity is
 * part of the frozen contract; changing that is a dependency-design decision,
 * not a structural move.
 */
export const DECLARED_REVIEW_ZONE_EDGES: ReadonlySet<string> = new Set([
  'review/context -> review',
  'review/dispatch -> review',
  'review/dispatch -> review/context',
  'review/dispatch -> review/enforcement',
  'review/dispatch -> review/evidence',
  'review/dispatch -> review/obligations',
  'review/dispatch -> review/observations',
  'review/dispatch -> review/prompting',
  'review/enforcement -> review',
  'review/enforcement -> review/obligations',
  'review/evidence -> review',
  'review/evidence -> review/context',
  'review/evidence -> review/obligations',
  'review/evidence -> review/observations',
  'review/obligations -> review',
  'review/obligations -> review/context',
  'review/observations -> review/enforcement',
  'review/observations -> review/obligations',
  'review/prompting -> review/context',
  'review/prompting -> review/enforcement',
  'review/prompting -> review/evidence',
  'review/prompting -> review/obligations',
  'review/prompting -> review',
  'review/validation -> review',
  'review/validation -> review/enforcement',
  'review/validation -> review/obligations',
  'review/validation -> review/observations',
]);

export interface ReviewZoneViolation {
  readonly rule: string;
  readonly file: string;
  readonly message: string;
  /** Concrete repair step for this rule. */
  readonly hint?: string;
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

/**
 * Relative module specifiers from the shared AST collector
 * (`import-specifiers.ts`). Comments between `from`/`import` and the string
 * literal are trivia and cannot hide an edge, while commented-out imports and
 * import-looking string content cannot fabricate one.
 */
function relativeSpecifiers(sourceText: string): string[] {
  return collectImportSpecifiers(sourceText)
    .map((specifier) => specifier.module)
    .filter((module) => module.startsWith('.'));
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

interface ReviewZoneObservation {
  readonly observedEdges: ReadonlySet<string>;
}

function observeReviewZones(
  input: Pick<ReviewZoneAnalysisInput, 'sources' | 'zones'>,
): ReviewZoneObservation {
  const zoneByDir = new Map(input.zones.map((zone) => [zone.dir, zone]));
  const observed = new Set<string>();

  for (const source of input.sources) {
    if (isTestSourcePath(source.rel)) continue;
    for (const specifier of relativeSpecifiers(source.content)) {
      const target = resolveSpecifier(source.rel, specifier);
      if (!target.startsWith(REVIEW_DIR_PREFIX)) continue;
      const fromZone = reviewZoneOf(source.rel, zoneByDir);
      const toZone = reviewZoneOf(target, zoneByDir);
      if (fromZone === undefined || toZone === undefined || fromZone === toZone) continue;
      observed.add(zoneEdgeKey(fromZone, toZone));
    }
  }

  return { observedEdges: observed };
}

/** The observed review zone edge set, exposed for graph-shape assertions. */
export function reviewZoneEdges(
  input: Pick<ReviewZoneAnalysisInput, 'sources' | 'zones'>,
): ReadonlySet<string> {
  return observeReviewZones(input).observedEdges;
}

/** Every zone pair that observes BOTH directions, rendered as `a <-> b`. */
export function mutualZonePairs(edges: Iterable<string>): readonly string[] {
  const directed = new Set(edges);
  const pairs: string[] = [];
  for (const edge of directed) {
    const [from, to] = edge.split(' -> ');
    if (from === undefined || to === undefined) continue;
    const reverse = zoneEdgeKey(to, from);
    if (!directed.has(reverse)) continue;
    const [left, right] = [from, to].sort();
    const canonical = `${left} <-> ${right}`;
    if (!pairs.includes(canonical)) pairs.push(canonical);
  }
  return pairs.sort();
}

/**
 * Review zone cycles as deterministic strongly connected components. The
 * real-tree policy test requires this projection to be empty.
 */
export function reviewZoneCycles(edges: Iterable<string>): readonly (readonly string[])[] {
  const edgeList: ModuleEdge[] = [];
  const zones = new Set<string>();
  for (const edge of edges) {
    const [from, to] = edge.split(' -> ');
    if (from === undefined || to === undefined) continue;
    zones.add(from);
    zones.add(to);
    edgeList.push({ from, to });
  }
  return stronglyConnectedComponents([...zones], edgeList).filter(
    (component) => component.length >= 2,
  );
}

export function analyzeReviewZonePolicy(input: ReviewZoneAnalysisInput): ReviewZoneViolation[] {
  const violations: ReviewZoneViolation[] = [];
  const { observedEdges } = observeReviewZones(input);

  for (const edge of observedEdges) {
    if (!input.declaredEdges.has(edge)) {
      violations.push({
        rule: 'undeclared-zone-edge',
        file: edge,
        message: 'observed review zone edge is not declared in the zone policy',
        hint: `Add '${edge}' to DECLARED_REVIEW_ZONE_EDGES as a dependency-design decision; the zone graph must stay acyclic.`,
      });
    }
  }
  for (const edge of input.declaredEdges) {
    if (!observedEdges.has(edge)) {
      violations.push({
        rule: 'stale-zone-edge',
        file: edge,
        message: 'declared review zone edge is no longer observed',
        hint: `Remove '${edge}' from DECLARED_REVIEW_ZONE_EDGES; the import no longer exists.`,
      });
    }
  }

  return violations;
}
