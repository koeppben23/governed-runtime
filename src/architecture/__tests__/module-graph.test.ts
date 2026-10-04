/**
 * @module architecture/module-graph.test
 * @description Unit tests for the pure module-graph algorithms, the deduplicated
 * edge contract, and the completeness of the positive module-direction policy.
 */

import { describe, expect, it } from 'vitest';

import { MODULE_CLASSIFICATION, type GovernedModuleName } from './module-classification.js';
import { MODULE_DEPENDENCY_POLICY } from './module-dependency-policy.js';
import {
  cycleParticipatingEdges,
  cyclicStronglyConnectedComponents,
  edgeKey,
  moduleEdgeSet,
  stronglyConnectedComponents,
  type ModuleEdge,
} from './module-graph.js';

const GOVERNED_NAMES = MODULE_CLASSIFICATION.filter((entry) => entry.kind === 'governed').map(
  (entry) => entry.name,
);

function edge(from: string, to: string): ModuleEdge {
  return { from, to };
}

function componentLabels(components: readonly (readonly string[])[]): string[] {
  return components.map((component) => [...component].sort().join(','));
}

describe('MODULE_DEPENDENCY_POLICY completeness', () => {
  it('has exactly one entry for every governed module and no other entry', () => {
    expect(Object.keys(MODULE_DEPENDENCY_POLICY).sort()).toEqual([...GOVERNED_NAMES].sort());
  });

  it('references governed modules only and never a self edge', () => {
    for (const [source, targets] of Object.entries(MODULE_DEPENDENCY_POLICY)) {
      expect(GOVERNED_NAMES, `${source} must be governed`).toContain(source);
      for (const target of targets) {
        expect(GOVERNED_NAMES, `${source} -> ${target} must be governed`).toContain(target);
        expect(target, `${source} must not allow a self edge`).not.toBe(source);
      }
    }
  });
});

describe('moduleEdgeSet', () => {
  it('deduplicates repeated from -> to edges and keeps a stable key', () => {
    const edges = [
      edge('integration', 'state'),
      edge('integration', 'state'),
      edge('rails', 'state'),
    ];
    const set = moduleEdgeSet(edges);
    expect(set.size).toBe(2);
    expect(set.has(edgeKey('integration', 'state'))).toBe(true);
    expect(set.has(edgeKey('rails', 'state'))).toBe(true);
  });
});

describe('stronglyConnectedComponents', () => {
  it('detects a two-module cycle', () => {
    const cyclic = cyclicStronglyConnectedComponents(['a', 'b'], [edge('a', 'b'), edge('b', 'a')]);
    expect(componentLabels(cyclic)).toEqual(['a,b']);
  });

  it('detects a three-module cycle and keeps an attached acyclic tail out', () => {
    const modules = ['a', 'b', 'c', 'tail'];
    const edges = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a'), edge('c', 'tail')];
    expect(componentLabels(cyclicStronglyConnectedComponents(modules, edges))).toEqual(['a,b,c']);
    expect(cycleParticipatingEdges(modules, edges)).toEqual([
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'a'),
    ]);
  });

  it('keeps two disjoint cycles separate', () => {
    const modules = ['a', 'b', 'c', 'd'];
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('c', 'd'), edge('d', 'c')];
    expect(componentLabels(cyclicStronglyConnectedComponents(modules, edges))).toEqual([
      'a,b',
      'c,d',
    ]);
  });

  it('treats a self edge as a singleton, never a cycle', () => {
    const modules = ['a'];
    const edges = [edge('a', 'a')];
    expect(cyclicStronglyConnectedComponents(modules, edges)).toEqual([]);
    expect(cycleParticipatingEdges(modules, edges)).toEqual([]);
  });

  it('merges two components into one cyclic SCC when a closing edge appears', () => {
    const modules = ['a', 'b', 'c'];
    const acyclic = [edge('a', 'b'), edge('b', 'c')];
    expect(cyclicStronglyConnectedComponents(modules, acyclic)).toEqual([]);
    const cyclic = [...acyclic, edge('c', 'a')];
    expect(componentLabels(cyclicStronglyConnectedComponents(modules, cyclic))).toEqual(['a,b,c']);
    expect(cycleParticipatingEdges(modules, cyclic)).toEqual([
      edge('a', 'b'),
      edge('b', 'c'),
      edge('c', 'a'),
    ]);
  });

  it('excludes an edge whose target cannot reach its source', () => {
    const modules = ['a', 'b', 'leaf'];
    const edges = [edge('a', 'b'), edge('b', 'a'), edge('a', 'leaf')];
    expect(cycleParticipatingEdges(modules, edges)).toEqual([edge('a', 'b'), edge('b', 'a')]);
  });

  it('is deterministic under edge-order permutations', () => {
    const modules = ['a', 'b', 'c'];
    const forward = [edge('a', 'b'), edge('b', 'c'), edge('c', 'a')];
    const shuffled = [edge('c', 'a'), edge('a', 'b'), edge('b', 'c')];
    expect(stronglyConnectedComponents(modules, forward)).toEqual(
      stronglyConnectedComponents(modules, shuffled),
    );
    expect(cycleParticipatingEdges(modules, forward)).toEqual(
      cycleParticipatingEdges(modules, shuffled),
    );
  });

  it('consumes a one-shot iterable only once', () => {
    const modules = ['a', 'b', 'leaf'];
    const oneShot = function* (): Generator<{ from: string; to: string }> {
      yield edge('a', 'b');
      yield edge('b', 'a');
      yield edge('a', 'leaf');
    };
    expect(cycleParticipatingEdges(modules, oneShot())).toEqual([edge('a', 'b'), edge('b', 'a')]);
  });
});
