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
 * cycle carve-out — the declared set IS the contract.
 *
 * Graph shape: direct mutual zone pairs are a hard gate (`mutualZonePairs`
 * must be empty). Longer cycles (length >= 3) remain permitted and are
 * reported as a metric (`reviewZoneCycles`); a fully acyclic review zone graph
 * is a separate architecture goal, not an implicit requirement of this policy.
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

import * as ts from 'typescript';

import { isTestSourcePath } from './module-classification.js';
import type { IntegrationPlacementZone } from './integration-placement-policy.js';
import { stronglyConnectedComponents, type ModuleEdge } from './module-graph.js';

/** Public facade of the review bounded context. */
const REVIEW_FACADE_FILE = 'integration/review/index.ts';

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
 * a declared edge that stops being observed fails as stale. Zone cycles are
 * part of the frozen contract; changing that is a dependency-design decision,
 * not a structural move.
 */
export const DECLARED_REVIEW_ZONE_EDGES: ReadonlySet<string> = new Set([
  'review -> review/enforcement',
  'review -> review/prompting',
  'review/context -> review',
  'review/dispatch -> review',
  'review/dispatch -> review/context',
  'review/dispatch -> review/enforcement',
  'review/dispatch -> review/evidence',
  'review/dispatch -> review/obligations',
  'review/dispatch -> review/observations',
  'review/dispatch -> review/prompting',
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
  'review/validation -> review',
  'review/validation -> review/enforcement',
  'review/validation -> review/obligations',
  'review/validation -> review/observations',
]);

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

/**
 * Relative module specifiers from the syntax tree.
 *
 * This is deliberately AST-based, not regex-based: comments between `from`/
 * `import` and the string literal are trivia and cannot hide an edge, while
 * commented-out imports and import-looking string content cannot fabricate one.
 * Covered forms: `import ... from`, `export ... from`, `import x = require(...)`,
 * dynamic `import()`, and `require()`.
 */
function relativeSpecifiers(sourceText: string): string[] {
  const sourceFile = ts.createSourceFile(
    'review-zone.ts',
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const out: string[] = [];

  const collect = (specifier: ts.Expression | undefined): void => {
    if (specifier !== undefined && ts.isStringLiteralLike(specifier)) {
      if (specifier.text.startsWith('.')) out.push(specifier.text);
    }
  };

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      collect(node.moduleSpecifier);
    } else if (ts.isImportEqualsDeclaration(node)) {
      const reference = node.moduleReference;
      if (ts.isExternalModuleReference(reference)) {
        collect(reference.expression);
      }
    } else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      if (isDynamicImport || isRequire) {
        collect(node.arguments[0]);
      }
    }
    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
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

interface ReviewZoneObservation {
  readonly facadeViolations: readonly ReviewZoneViolation[];
  readonly observedEdges: ReadonlySet<string>;
}

function observeReviewZones(input: ReviewZoneAnalysisInput): ReviewZoneObservation {
  const facadeViolations: ReviewZoneViolation[] = [];
  const zoneByDir = new Map(input.zones.map((zone) => [zone.dir, zone]));
  const observed = new Set<string>();

  for (const source of input.sources) {
    if (isTestSourcePath(source.rel)) continue;
    for (const specifier of relativeSpecifiers(source.content)) {
      const target = resolveSpecifier(source.rel, specifier);
      if (target === REVIEW_FACADE_FILE) {
        facadeViolations.push({
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

  return { facadeViolations, observedEdges: observed };
}

/** The observed review zone edge set, exposed for graph-shape assertions. */
export function reviewZoneEdges(
  input: Pick<ReviewZoneAnalysisInput, 'sources' | 'zones'>,
): ReadonlySet<string> {
  return observeReviewZones({ ...input, declaredEdges: new Set() }).observedEdges;
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
 * Remaining review zone cycles (length ≥ 3 — direct mutual pairs are excluded
 * by the hard gate) as a deterministic metric. This is reported, not gated:
 * a fully acyclic review zone graph is a separate architecture goal.
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
  const { facadeViolations, observedEdges } = observeReviewZones(input);
  violations.push(...facadeViolations);

  for (const edge of observedEdges) {
    if (!input.declaredEdges.has(edge)) {
      violations.push({
        rule: 'undeclared-zone-edge',
        file: edge,
        message: 'observed review zone edge is not declared in the zone policy',
      });
    }
  }
  for (const edge of input.declaredEdges) {
    if (!observedEdges.has(edge)) {
      violations.push({
        rule: 'stale-zone-edge',
        file: edge,
        message: 'declared review zone edge is no longer observed',
      });
    }
  }

  return violations;
}
