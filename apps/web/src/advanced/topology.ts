/**
 * Advanced: topology analysis over the planned repeater network.
 *
 * Pure, dependency-free graph algorithms backing the advanced-mode topology
 * overlays and the "what happens if this site goes down" analysis:
 *
 *  - weak connectivity across ALL edges regardless of kind — `observed` vs
 *    `predicted` only feeds the per-kind counters in `TopoStats`;
 *  - articulation points and bridges via iterative Tarjan (explicit stack),
 *    so 10k-node / 40k-edge planner graphs cannot overflow the call stack;
 *  - whole-network stats and single-site removal impact.
 *
 * Determinism: every returned array is sorted by node id using plain
 * code-unit comparison, so fixtures stay stable across platforms/locales.
 * No DOM, no external dependencies; inputs are never mutated.
 */

export interface TopoNode {
  id: string;
  name: string | null;
  lat: number;
  lon: number;
}

export type EdgeKind = 'observed' | 'predicted';

export interface TopoEdge {
  aId: string;
  bId: string;
  kind: EdgeKind;
}

export interface TopoStats {
  nodeCount: number;
  observedEdgeCount: number;
  predictedEdgeCount: number;
  componentCount: number;
  largestComponentSize: number;
  isolatedNodeIds: string[];
}

export interface RemovalImpact {
  removedId: string;
  componentsBefore: number;
  componentsAfter: number;
  splitOffNodeIds: string[];
  /** Nodes that were connected before removal and have degree 0 after it. */
  isolatedAfterRemoval: string[];
  largestComponentSizeAfter: number;
  /** true when removing the node disconnects its component into >= 2 parts */
  isArticulation: boolean;
}

/** Plain code-unit lexicographic comparison — locale-independent and stable. */
function compareIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

type IdPair = [string, string];

function orderPair(a: string, b: string): IdPair {
  return a <= b ? [a, b] : [b, a];
}

function comparePairs(x: IdPair, y: IdPair): number {
  return compareIds(x[0], y[0]) || compareIds(x[1], y[1]);
}

/**
 * Adjacency map over every declared node plus every edge endpoint, so the
 * analysis covers the full graph even if an edge references a node id that
 * was not declared.
 *
 * Self-loop edges (aId === bId) are ignored: they carry no connectivity and
 * would otherwise inflate a node's degree, contradicting the "isolated"
 * semantics used by `stats` and `removalImpact`.
 */
export function buildAdjacency(nodes: TopoNode[], edges: TopoEdge[]): Map<string, Set<string>> {
  const adj = new Map<string, Set<string>>();
  const setFor = (id: string): Set<string> => {
    let s = adj.get(id);
    if (s === undefined) {
      s = new Set<string>();
      adj.set(id, s);
    }
    return s;
  };
  for (const n of nodes) setFor(n.id);
  for (const e of edges) {
    if (e.aId === e.bId) continue;
    setFor(e.aId).add(e.bId);
    setFor(e.bId).add(e.aId);
  }
  return adj;
}

/**
 * Weakly connected components of an adjacency map.
 *
 * Each component's ids are sorted ascending; the component array is sorted
 * by size descending, ties broken by the lexicographically smallest id.
 */
function componentsOfAdjacency(adj: Map<string, Set<string>>): string[][] {
  const components: string[][] = [];
  const seen = new Set<string>();
  for (const start of [...adj.keys()].sort(compareIds)) {
    if (seen.has(start)) continue;
    const comp: string[] = [];
    const stack: string[] = [start];
    seen.add(start);
    while (stack.length > 0) {
      const v = stack.pop()!;
      comp.push(v);
      for (const w of adj.get(v) ?? []) {
        if (!seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    comp.sort(compareIds);
    components.push(comp);
  }
  components.sort((a, b) => b.length - a.length || compareIds(a[0]!, b[0]!));
  return components;
}

export function connectedComponents(nodes: TopoNode[], edges: TopoEdge[]): string[][] {
  return componentsOfAdjacency(buildAdjacency(nodes, edges));
}

interface TarjanResult {
  articulation: string[];
  bridges: IdPair[];
}

interface DfsFrame {
  v: string;
  neighbors: string[];
  i: number;
}

/**
 * Iterative Tarjan DFS (explicit stack + per-frame neighbour cursor).
 * Finds cut vertices and bridges of the undirected graph in one pass.
 */
function tarjan(adj: Map<string, Set<string>>): TarjanResult {
  const neighbors = new Map<string, string[]>();
  for (const [v, set] of adj) neighbors.set(v, [...set].sort(compareIds));
  const neighborsOf = (v: string): string[] => neighbors.get(v) ?? [];

  const disc = new Map<string, number>();
  const low = new Map<string, number>();
  const parent = new Map<string, string | null>();
  const childCount = new Map<string, number>();
  const apSet = new Set<string>();
  const bridgeList: IdPair[] = [];
  let timer = 0;

  for (const root of [...adj.keys()].sort(compareIds)) {
    if (disc.has(root)) continue;
    disc.set(root, timer);
    low.set(root, timer);
    timer += 1;
    parent.set(root, null);
    childCount.set(root, 0);

    const stack: DfsFrame[] = [{ v: root, neighbors: neighborsOf(root), i: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      if (frame.i < frame.neighbors.length) {
        const w = frame.neighbors[frame.i]!;
        frame.i += 1;
        if (!disc.has(w)) {
          disc.set(w, timer);
          low.set(w, timer);
          timer += 1;
          parent.set(w, frame.v);
          childCount.set(w, 0);
          childCount.set(frame.v, (childCount.get(frame.v) ?? 0) + 1);
          stack.push({ v: w, neighbors: neighborsOf(w), i: 0 });
        } else if (parent.get(frame.v) !== w) {
          // Back edge (the immediate parenting edge is skipped): a lower
          // discovery time reachable from this subtree.
          low.set(frame.v, Math.min(low.get(frame.v)!, disc.get(w)!));
        }
      } else {
        stack.pop();
        const p = parent.get(frame.v);
        if (p !== null && p !== undefined) {
          low.set(p, Math.min(low.get(p)!, low.get(frame.v)!));
          if (low.get(frame.v)! > disc.get(p)!) bridgeList.push(orderPair(p, frame.v));
          // Non-root p is a cut vertex when a child subtree cannot reach
          // anything discovered before p.
          if (parent.get(p) !== null && low.get(frame.v)! >= disc.get(p)!) apSet.add(p);
        }
      }
    }
    // Root is a cut vertex only when it has more than one DFS child.
    if ((childCount.get(root) ?? 0) > 1) apSet.add(root);
  }

  return {
    articulation: [...apSet].sort(compareIds),
    bridges: bridgeList.sort(comparePairs),
  };
}

/** Cut vertices, sorted ascending by id. */
export function articulationPoints(nodes: TopoNode[], edges: TopoEdge[]): string[] {
  return tarjan(buildAdjacency(nodes, edges)).articulation;
}

/** Bridges as id pairs with each pair ordered a < b; the array is lexicographic. */
export function bridges(nodes: TopoNode[], edges: TopoEdge[]): Array<[string, string]> {
  return tarjan(buildAdjacency(nodes, edges)).bridges;
}

export function stats(nodes: TopoNode[], edges: TopoEdge[]): TopoStats {
  const adj = buildAdjacency(nodes, edges);
  const components = componentsOfAdjacency(adj);

  let observedEdgeCount = 0;
  for (const e of edges) if (e.kind === 'observed') observedEdgeCount += 1;

  const isolatedNodeIds: string[] = [];
  for (const [id, set] of adj) if (set.size === 0) isolatedNodeIds.push(id);
  isolatedNodeIds.sort(compareIds);

  return {
    nodeCount: adj.size,
    observedEdgeCount,
    predictedEdgeCount: edges.length - observedEdgeCount,
    componentCount: components.length,
    largestComponentSize: components.length === 0 ? 0 : components[0]!.length,
    isolatedNodeIds,
  };
}

/**
 * Impact of removing one node (and its incident edges).
 *
 * `splitOffNodeIds` lists every remaining node that is no longer in the
 * largest post-removal fragment of the removed node's original component —
 * i.e. exactly the nodes that a site outage would strand outside the
 * surviving main cluster of that component. Empty when the component does
 * not split. `largestComponentSizeAfter` is the largest component of the
 * WHOLE graph after removal.
 */
export function removalImpact(nodes: TopoNode[], edges: TopoEdge[], removedId: string): RemovalImpact {
  const adjBefore = buildAdjacency(nodes, edges);
  const before = componentsOfAdjacency(adjBefore);

  // Unknown id: removal is a no-op, report the untouched graph.
  if (!adjBefore.has(removedId)) {
    return {
      removedId,
      componentsBefore: before.length,
      componentsAfter: before.length,
      splitOffNodeIds: [],
      isolatedAfterRemoval: [],
      largestComponentSizeAfter: before.length === 0 ? 0 : before[0]!.length,
      isArticulation: false,
    };
  }

  const nodesAfter = nodes.filter((n) => n.id !== removedId);
  const edgesAfter = edges.filter((e) => e.aId !== removedId && e.bId !== removedId);
  const adjAfter = buildAdjacency(nodesAfter, edgesAfter);
  const after = componentsOfAdjacency(adjAfter);

  // Newly isolated only: degree 0 after removal, but connected before it.
  const isolatedAfterRemoval: string[] = [];
  for (const [id, set] of adjAfter) {
    if (set.size === 0 && (adjBefore.get(id)?.size ?? 0) > 0) isolatedAfterRemoval.push(id);
  }
  isolatedAfterRemoval.sort(compareIds);

  // Fragments of the removed node's original component once the node is gone.
  const removedComponent = before.find((c) => c.includes(removedId)) ?? [];
  const remaining = new Set(removedComponent.filter((id) => id !== removedId));
  const seen = new Set<string>();
  const fragments: string[][] = [];
  for (const start of [...remaining].sort(compareIds)) {
    if (seen.has(start)) continue;
    const fragment: string[] = [];
    const stack: string[] = [start];
    seen.add(start);
    while (stack.length > 0) {
      const v = stack.pop()!;
      fragment.push(v);
      for (const w of adjAfter.get(v) ?? []) {
        if (remaining.has(w) && !seen.has(w)) {
          seen.add(w);
          stack.push(w);
        }
      }
    }
    fragment.sort(compareIds);
    fragments.push(fragment);
  }
  fragments.sort((a, b) => b.length - a.length || compareIds(a[0]!, b[0]!));

  const isArticulation = fragments.length >= 2;
  const splitOffNodeIds = isArticulation ? fragments.slice(1).flat().sort(compareIds) : [];

  return {
    removedId,
    componentsBefore: before.length,
    componentsAfter: after.length,
    splitOffNodeIds,
    isolatedAfterRemoval,
    largestComponentSizeAfter: after.length === 0 ? 0 : after[0]!.length,
    isArticulation,
  };
}
