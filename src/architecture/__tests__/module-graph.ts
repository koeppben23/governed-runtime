/**
 * @module architecture/module-graph
 * @description Pure graph algorithms for the module-level architecture guards.
 *
 * This module owns NO import parsing and NO filesystem access: callers pass the
 * normalized directed module edges they derived from the single import-analysis
 * authority. It provides deterministic strongly-connected-component detection
 * and the intra-SCC edge projection that the cycle-debt baseline freezes.
 *
 * Self edges are never cross-module cycles: an SCC must have at least two
 * members to be cyclic.
 *
 * @version v1
 */

export interface ModuleEdge {
  readonly from: string;
  readonly to: string;
}

/** Deduplicated identity of a directed module edge. */
export function edgeKey(from: string, to: string): string {
  return `${from}\u0000${to}`;
}

/** Deduplicated directed edge set; many files of one direction collapse to one. */
export function moduleEdgeSet(edges: Iterable<ModuleEdge>): ReadonlySet<string> {
  const set = new Set<string>();
  for (const edge of edges) set.add(edgeKey(edge.from, edge.to));
  return set;
}

function buildAdjacency(
  modules: readonly string[],
  edges: Iterable<ModuleEdge>,
): ReadonlyMap<string, readonly string[]> {
  const adjacency = new Map<string, Set<string>>();
  for (const moduleName of modules) adjacency.set(moduleName, new Set());
  for (const edge of edges) {
    if (edge.from === edge.to) continue;
    adjacency.get(edge.from)?.add(edge.to);
  }
  const sorted = new Map<string, readonly string[]>();
  for (const [moduleName, targets] of adjacency) {
    sorted.set(moduleName, [...targets].sort());
  }
  return sorted;
}

/**
 * Tarjan strongly connected components over a deterministic, sorted traversal.
 * The result is sorted by component (first member, then full member list).
 */
export function stronglyConnectedComponents(
  modules: readonly string[],
  edges: Iterable<ModuleEdge>,
): readonly (readonly string[])[] {
  const adjacency = buildAdjacency([...modules].sort(), edges);
  const index = new Map<string, number>();
  const lowlink = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const components: string[][] = [];
  let nextIndex = 0;

  const visit = (node: string): void => {
    index.set(node, nextIndex);
    lowlink.set(node, nextIndex);
    nextIndex += 1;
    stack.push(node);
    onStack.add(node);

    for (const target of adjacency.get(node) ?? []) {
      if (!index.has(target)) {
        visit(target);
        lowlink.set(node, Math.min(lowlink.get(node)!, lowlink.get(target)!));
      } else if (onStack.has(target)) {
        lowlink.set(node, Math.min(lowlink.get(node)!, index.get(target)!));
      }
    }

    if (lowlink.get(node) !== index.get(node)) return;
    const component: string[] = [];
    for (;;) {
      const member = stack.pop()!;
      onStack.delete(member);
      component.push(member);
      if (member === node) break;
    }
    components.push(component.sort());
  };

  for (const moduleName of [...adjacency.keys()].sort()) {
    if (!index.has(moduleName)) visit(moduleName);
  }

  return components.sort((a, b) => a.join('\u0000').localeCompare(b.join('\u0000')));
}

/** Cyclic SCCs — every component with at least two members. */
export function cyclicStronglyConnectedComponents(
  modules: readonly string[],
  edges: Iterable<ModuleEdge>,
): readonly (readonly string[])[] {
  return stronglyConnectedComponents(modules, edges).filter((component) => component.length >= 2);
}

/**
 * The exact directed edges that participate in a module cycle: both endpoints
 * lie in the same cyclic SCC. Self edges are excluded. Deterministically
 * sorted by `from` then `to`.
 */
export function cycleParticipatingEdges(
  modules: readonly string[],
  edges: Iterable<ModuleEdge>,
): readonly ModuleEdge[] {
  const edgeList = [...edges];
  const cyclicMembers = new Set<string>();
  const componentOf = new Map<string, number>();
  cyclicStronglyConnectedComponents(modules, edgeList).forEach((component, componentIndex) => {
    for (const member of component) {
      cyclicMembers.add(member);
      componentOf.set(member, componentIndex);
    }
  });
  return edgeList
    .filter(
      (edge) =>
        edge.from !== edge.to &&
        cyclicMembers.has(edge.from) &&
        cyclicMembers.has(edge.to) &&
        componentOf.get(edge.from) === componentOf.get(edge.to),
    )
    .sort((a, b) => (a.from === b.from ? a.to.localeCompare(b.to) : a.from.localeCompare(b.from)));
}
