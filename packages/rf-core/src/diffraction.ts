/**
 * Terrain diffraction models.
 *
 * Single edge: ITU-R P.526 knife-edge approximation.
 * Multiple edges: Deygout construction (dominant edge first, then recursion
 * into left/right sub-paths, capped at `maxEdges` dominant edges).
 *
 * These are standard, published equations implemented from first principles —
 * no code was copied from HopReach or any other calculator (see D-003).
 */
import type { ProfilePoint } from '@ukmesh-planner/contracts';

/** ITU-R P.526 knife-edge loss for Fresnel parameter v (dB). */
export function knifeEdgeLossDb(v: number): number {
  if (v <= -0.7) return 0;
  return 6.9 + 20 * Math.log10(Math.sqrt((v - 0.1) ** 2 + 1) + v - 0.1);
}

/** Fresnel parameter from obstruction height above the line of sight. */
export function fresnelParameter(
  obstructionHeightAboveLosM: number,
  d1M: number,
  d2M: number,
  lambdaM: number,
): number {
  if (d1M <= 0 || d2M <= 0) return Number.NEGATIVE_INFINITY;
  return obstructionHeightAboveLosM * Math.sqrt((2 * (1 / d1M + 1 / d2M)) / lambdaM);
}

interface DeygoutResult {
  lossDb: number;
  worstEdgeIndex: number | null;
  /** Fresnel parameter v of the dominant edge (null when no edge above LOS). */
  worstV: number | null;
}

/**
 * Deygout diffraction loss over a sampled profile.
 *
 * Interior obstacle tops are effective terrain heights above the *original*
 * chord (`terrainM + earthBulgeAdjM`). Sub-path endpoints are the antenna tops
 * (original ends) or the top of a previously selected edge.
 */
export function deygoutLossDb(
  points: ProfilePoint[],
  lambdaM: number,
  maxEdges = 3,
): DeygoutResult {
  if (points.length < 3) return { lossDb: 0, worstEdgeIndex: null, worstV: null };

  const n = points.length;
  const first = points[0]!;
  const last = points[n - 1]!;
  if (!Number.isFinite(first.lineHeightM) || !Number.isFinite(last.lineHeightM)) {
    return { lossDb: 0, worstEdgeIndex: null, worstV: null };
  }
  const originalTops = {
    start: first.lineHeightM, // antenna top, ASL
    end: last.lineHeightM,
  };

  let totalLossDb = 0;
  let overallWorstIndex: number | null = null;
  let overallWorstV: number | null = null;

  interface Segment {
    i0: number;
    i1: number;
    top0: number; // height (ASL-effective over chord) at segment start
    top1: number;
    depth: number;
  }

  const stack: Segment[] = [
    { i0: 0, i1: n - 1, top0: originalTops.start, top1: originalTops.end, depth: 0 },
  ];
  let edgesFound = 0;

  while (stack.length > 0 && edgesFound < maxEdges) {
    const seg = stack.pop()!;
    const d0 = points[seg.i0]!.distanceM;
    const d1 = points[seg.i1]!.distanceM;
    const span = d1 - d0;
    if (span <= 0 || seg.i1 - seg.i0 < 2) continue;

    // Find the dominant obstruction in this segment.
    let bestV = Number.NEGATIVE_INFINITY;
    let bestI = -1;
    for (let i = seg.i0 + 1; i < seg.i1; i += 1) {
      const p = points[i]!;
      const terrainM = p.terrainM;
      if (terrainM === null || !Number.isFinite(terrainM) || !Number.isFinite(p.clearanceM)) continue;
      const di = p.distanceM - d0;
      const dj = d1 - p.distanceM;
      if (di <= 0 || dj <= 0) continue;
      const lineAtI = seg.top0 + ((seg.top1 - seg.top0) * di) / span;
      const effTerrain = terrainM + p.earthBulgeAdjM;
      const h = effTerrain - lineAtI; // height above the (sub-)path line
      if (h <= 0) continue;
      const v = fresnelParameter(h, di, dj, lambdaM);
      if (v > bestV) {
        bestV = v;
        bestI = i;
      }
    }

    if (bestI === -1 || bestV <= -0.7) continue;

    totalLossDb += knifeEdgeLossDb(bestV);
    edgesFound += 1;
    if (overallWorstV === null || bestV > overallWorstV) {
      overallWorstV = bestV;
      overallWorstIndex = bestI;
    }

    // Recurse into the two sub-paths with the edge top as the new endpoint.
    const p = points[bestI]!;
    const topTerrainM = p.terrainM;
    if (topTerrainM === null) continue;
    const edgeTop = topTerrainM + p.earthBulgeAdjM;
    stack.push({ i0: bestI, i1: seg.i1, top0: edgeTop, top1: seg.top1, depth: seg.depth + 1 });
    stack.push({ i0: seg.i0, i1: bestI, top0: seg.top0, top1: edgeTop, depth: seg.depth + 1 });
  }

  return { lossDb: totalLossDb, worstEdgeIndex: overallWorstIndex, worstV: overallWorstV };
}
