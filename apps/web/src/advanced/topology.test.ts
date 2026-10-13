import { describe, expect, it } from 'vitest';
import {
  articulationPoints,
  bridges,
  buildAdjacency,
  connectedComponents,
  removalImpact,
  stats,
  type EdgeKind,
  type TopoEdge,
  type TopoNode,
} from './topology.js';

const node = (id: string): TopoNode => ({ id, name: null, lat: 0, lon: 0 });
const nodes = (...ids: string[]): TopoNode[] => ids.map(node);
const edge = (aId: string, bId: string, kind: EdgeKind = 'observed'): TopoEdge => ({ aId, bId, kind });

/** Two triangles ({a1,a2,a3} and {b1,b2,b3}) joined only by the bridge a3-b1. */
function twoTriangles(): { ns: TopoNode[]; es: TopoEdge[] } {
  return {
    ns: nodes('a1', 'a2', 'a3', 'b1', 'b2', 'b3'),
    es: [
      edge('a1', 'a2'),
      edge('a2', 'a3'),
      edge('a1', 'a3'),
      edge('b1', 'b2'),
      edge('b2', 'b3'),
      edge('b1', 'b3'),
      edge('a3', 'b1'),
    ],
  };
}

/** Small deterministic PRNG for the large-graph fixture. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('topology analysis', () => {
  it('counts two disjoint clusters as separate components and picks the largest', () => {
    const ns = nodes('a', 'b', 'c', 'x', 'y');
    const es = [edge('a', 'b'), edge('b', 'c'), edge('x', 'y')];

    expect(connectedComponents(ns, es)).toEqual([
      ['a', 'b', 'c'],
      ['x', 'y'],
    ]);

    const s = stats(ns, es);
    expect(s.nodeCount).toBe(5);
    expect(s.componentCount).toBe(2);
    expect(s.largestComponentSize).toBe(3);
  });

  it('finds articulation points and bridges on the chain a-b-c-d', () => {
    const ns = nodes('a', 'b', 'c', 'd');
    const es = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];

    expect(articulationPoints(ns, es)).toEqual(['b', 'c']);
    expect(bridges(ns, es)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]);
    expect(stats(ns, es)).toEqual({
      nodeCount: 4,
      observedEdgeCount: 3,
      predictedEdgeCount: 0,
      componentCount: 1,
      largestComponentSize: 4,
      isolatedNodeIds: [],
    });
  });

  it('flags only the hub of a star (centre + 4 leaves)', () => {
    const ns = nodes('c', 'l1', 'l2', 'l3', 'l4');
    const es = ['l1', 'l2', 'l3', 'l4'].map((l) => edge('c', l));

    expect(articulationPoints(ns, es)).toEqual(['c']);
    expect(bridges(ns, es)).toEqual([
      ['c', 'l1'],
      ['c', 'l2'],
      ['c', 'l3'],
      ['c', 'l4'],
    ]);
    expect(stats(ns, es).largestComponentSize).toBe(5);
  });

  it('reports no articulation points or bridges for a cycle', () => {
    const ns = nodes('a', 'b', 'c', 'd');
    const es = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd'), edge('d', 'a')];

    expect(articulationPoints(ns, es)).toEqual([]);
    expect(bridges(ns, es)).toEqual([]);
    const s = stats(ns, es);
    expect(s.componentCount).toBe(1);
    expect(s.largestComponentSize).toBe(4);
  });

  it('flags the single joining edge between two clusters and both its endpoints', () => {
    const { ns, es } = twoTriangles();

    expect(bridges(ns, es)).toEqual([['a3', 'b1']]);
    expect(articulationPoints(ns, es)).toEqual(['a3', 'b1']);
    expect(stats(ns, es).componentCount).toBe(1);
    expect(stats(ns, es).largestComponentSize).toBe(6);
  });

  it('splits the network when a bridge endpoint is removed', () => {
    const { ns, es } = twoTriangles();

    const impact = removalImpact(ns, es, 'a3');
    expect(impact.componentsBefore).toBe(1);
    expect(impact.componentsAfter).toBe(2);
    expect(impact.isArticulation).toBe(true);
    expect(impact.splitOffNodeIds).toEqual(['a1', 'a2']);
    expect(impact.isolatedAfterRemoval).toEqual([]);
    expect(impact.largestComponentSizeAfter).toBe(3);

    // Removing the other endpoint mirrors the result.
    const mirror = removalImpact(ns, es, 'b1');
    expect(mirror.componentsBefore).toBe(1);
    expect(mirror.componentsAfter).toBe(2);
    expect(mirror.isArticulation).toBe(true);
    expect(mirror.splitOffNodeIds).toEqual(['b2', 'b3']);
  });

  it('does not flag a leaf removal as an articulation, and lists newly isolated nodes', () => {
    const ns = nodes('a', 'b', 'c', 'd');
    const es = [edge('a', 'b'), edge('b', 'c'), edge('c', 'd')];

    const impact = removalImpact(ns, es, 'd');
    expect(impact.isArticulation).toBe(false);
    expect(impact.componentsAfter).toBe(impact.componentsBefore);
    expect(impact.componentsBefore).toBe(1);
    expect(impact.splitOffNodeIds).toEqual([]);
    expect(impact.isolatedAfterRemoval).toEqual([]);
    expect(impact.isolatedAfterRemoval).not.toContain('d');
    expect(impact.largestComponentSizeAfter).toBe(3);

    // Removing the hub of a 2-node star strands the leaf: listed as isolated,
    // but that is not an articulation (one remaining fragment).
    const star = removalImpact(nodes('c', 'l'), [edge('c', 'l')], 'c');
    expect(star.isArticulation).toBe(false);
    expect(star.componentsBefore).toBe(1);
    expect(star.componentsAfter).toBe(1);
    expect(star.splitOffNodeIds).toEqual([]);
    expect(star.isolatedAfterRemoval).toEqual(['l']);
  });

  it('treats isolated nodes as their own components', () => {
    const ns = nodes('a', 'b', 'c', 'd');
    const es = [edge('c', 'd')];

    const s = stats(ns, es);
    expect(s.isolatedNodeIds).toEqual(['a', 'b']);
    expect(s.componentCount).toBe(3);
    expect(s.largestComponentSize).toBe(2);

    expect(connectedComponents(ns, es)).toEqual([['c', 'd'], ['a'], ['b']]);

    const adj = buildAdjacency(ns, es);
    expect([...adj.keys()].sort()).toEqual(['a', 'b', 'c', 'd']);
    expect(adj.get('a')?.size).toBe(0);
    expect(adj.get('c')).toEqual(new Set(['d']));
    expect(adj.get('d')).toEqual(new Set(['c']));
  });

  it('is deterministic under shuffled input order', () => {
    const ns = nodes('a1', 'a2', 'a3', 'b1', 'b2', 'b3', 'p', 'z');
    const es = [
      edge('a1', 'a2'),
      edge('a2', 'a3'),
      edge('a1', 'a3'),
      edge('b1', 'b2', 'predicted'),
      edge('b2', 'b3', 'predicted'),
      edge('b1', 'b3', 'predicted'),
      edge('a3', 'b1'),
      edge('p', 'a1', 'predicted'),
    ];
    const nsShuffled = [...ns].reverse();
    const esShuffled = [...es.slice(4), ...es.slice(2, 4), ...es.slice(0, 2)].reverse();

    const snapshot = (n: TopoNode[], e: TopoEdge[]): unknown[] => [
      stats(n, e),
      connectedComponents(n, e),
      articulationPoints(n, e),
      bridges(n, e),
      removalImpact(n, e, 'a3'),
      removalImpact(n, e, 'z'),
    ];

    expect(JSON.stringify(snapshot(nsShuffled, esShuffled))).toBe(JSON.stringify(snapshot(ns, es)));
  });

  it('counts observed and predicted edges separately while analysing both kinds', () => {
    const ns = nodes('a', 'b', 'c', 'd');
    const es = [edge('a', 'b', 'observed'), edge('b', 'c', 'predicted'), edge('c', 'd', 'observed')];

    const s = stats(ns, es);
    expect(s.observedEdgeCount).toBe(2);
    expect(s.predictedEdgeCount).toBe(1);
    // Weak connectivity ignores kind: the predicted edge still connects.
    expect(s.componentCount).toBe(1);
    expect(articulationPoints(ns, es)).toEqual(['b', 'c']);
    expect(bridges(ns, es)).toEqual([
      ['a', 'b'],
      ['b', 'c'],
      ['c', 'd'],
    ]);
  });

  it('handles an empty graph and removal of the sole node of a component', () => {
    expect(connectedComponents([], [])).toEqual([]);
    expect(articulationPoints([], [])).toEqual([]);
    expect(bridges([], [])).toEqual([]);
    expect(stats([], [])).toEqual({
      nodeCount: 0,
      observedEdgeCount: 0,
      predictedEdgeCount: 0,
      componentCount: 0,
      largestComponentSize: 0,
      isolatedNodeIds: [],
    });
    expect(removalImpact([], [], 'ghost')).toEqual({
      removedId: 'ghost',
      componentsBefore: 0,
      componentsAfter: 0,
      splitOffNodeIds: [],
      isolatedAfterRemoval: [],
      largestComponentSizeAfter: 0,
      isArticulation: false,
    });

    const lone = removalImpact(nodes('a'), [], 'a');
    expect(lone.componentsBefore).toBe(1);
    expect(lone.componentsAfter).toBe(0);
    expect(lone.isArticulation).toBe(false);
    expect(lone.splitOffNodeIds).toEqual([]);
    expect(lone.isolatedAfterRemoval).toEqual([]);
    expect(lone.largestComponentSizeAfter).toBe(0);
  });

  it('treats removal of an unknown id as a no-op', () => {
    const ns = nodes('a', 'b', 'c');
    const es = [edge('a', 'b'), edge('b', 'c')];

    const impact = removalImpact(ns, es, 'ghost');
    expect(impact.componentsBefore).toBe(1);
    expect(impact.componentsAfter).toBe(1);
    expect(impact.isArticulation).toBe(false);
    expect(impact.splitOffNodeIds).toEqual([]);
    expect(impact.largestComponentSizeAfter).toBe(3);
  });

  it('handles 10k nodes / 40k edges without recursion depth issues', () => {
    const side = 100;
    const ns: TopoNode[] = [];
    for (let r = 0; r < side; r += 1) for (let c = 0; c < side; c += 1) ns.push(node(`n${r}-${c}`));
    const key = (r: number, c: number): string => `n${r}-${c}`;

    const es: TopoEdge[] = [];
    for (let r = 0; r < side; r += 1) {
      for (let c = 0; c < side; c += 1) {
        if (c + 1 < side) es.push(edge(key(r, c), key(r, c + 1), 'observed'));
        if (r + 1 < side) es.push(edge(key(r, c), key(r + 1, c), 'predicted'));
      }
    }
    const rand = mulberry32(42);
    while (es.length < 40_000) {
      const r1 = Math.floor(rand() * side);
      const c1 = Math.floor(rand() * side);
      const r2 = Math.floor(rand() * side);
      const c2 = Math.floor(rand() * side);
      if (r1 === r2 && c1 === c2) continue;
      es.push(edge(key(r1, c1), key(r2, c2), rand() < 0.5 ? 'observed' : 'predicted'));
    }

    const s = stats(ns, es);
    expect(s.nodeCount).toBe(10_000);
    expect(s.componentCount).toBe(1);
    expect(s.largestComponentSize).toBe(10_000);
    expect(s.isolatedNodeIds).toEqual([]);
    expect(s.observedEdgeCount + s.predictedEdgeCount).toBe(es.length);
    expect(es.length).toBe(40_000);
    expect(connectedComponents(ns, es)).toHaveLength(1);
    expect(articulationPoints(ns, es)).toHaveLength(0);
    expect(bridges(ns, es)).toEqual([]);

    const impact = removalImpact(ns, es, key(50, 50));
    expect(impact.componentsBefore).toBe(1);
    expect(impact.componentsAfter).toBeGreaterThanOrEqual(1);
    expect(impact.componentsAfter).toBeLessThanOrEqual(2);
    // One component before -> the node is an articulation exactly when the
    // graph breaks into two afterwards.
    expect(impact.isArticulation).toBe(impact.componentsAfter >= 2);
    expect(impact.largestComponentSizeAfter).toBeLessThanOrEqual(9_999);
  });
});
