/**
 * Terrain profiles with earth-curvature correction (4/3 effective radius),
 * first-Fresnel-zone geometry and clearance metrics.
 *
 * Sign conventions (documented for parity fixtures):
 *  - `lineHeightM` is the straight chord between the two antenna tops, in
 *    absolute (ASL) metres, at each sample.
 *  - `earthBulgeAdjM` = d1·d2 / (2·R_eff): the effective height of the curved
 *    earth above the chord at this sample.
 *  - `clearanceM` = lineHeight − terrain − bulge. Negative ⇒ chord dips below
 *    the (curvature-adjusted) obstruction — physically obstructed.
 */
import type { ProfilePoint } from '@ukmesh-planner/contracts';
import {
  EFFECTIVE_EARTH_RADIUS_M,
  haversineDistanceM,
  interpolateGreatCircle,
  type LatLon,
} from './geo.js';

export interface TerrainProvider {
  /** Stable identifier for the DEM revision used (cache keys). */
  readonly revision: string;
  /** Elevation in metres, or null when unknown (never substitute 0). */
  elevationAt(p: LatLon): number | null;
}

export const SPEED_OF_LIGHT_M_S = 299_792_458;

export function wavelengthM(frequencyMhz: number): number {
  return SPEED_OF_LIGHT_M_S / (frequencyMhz * 1e6);
}

/** Effective height of the curved earth above the chord at distances d1, d2. */
export function earthBulgeM(
  d1M: number,
  d2M: number,
  effectiveRadiusM: number = EFFECTIVE_EARTH_RADIUS_M,
): number {
  return (d1M * d2M) / (2 * effectiveRadiusM);
}

/** First Fresnel-zone radius at a point dividing a path into d1 / d2. */
export function fresnelRadiusM(lambdaM: number, d1M: number, d2M: number): number {
  const d = d1M + d2M;
  if (d <= 0) return 0;
  return Math.sqrt((lambdaM * d1M * d2M) / d);
}

export interface ProfileOptions {
  frequencyMhz: number;
  /** Desired sample spacing; adaptive and clamped by min/max samples. */
  targetSpacingM?: number;
  minSamples?: number;
  maxSamples?: number;
}

export interface Profile {
  points: ProfilePoint[];
  totalDistanceM: number;
  unknownCount: number;
  /** Index of the worst-known clearance-ratio sample (interior points only). */
  worstIndex: number | null;
  /** Worst clearance ÷ F1 (can be negative); null when no interior known point. */
  worstClearanceRatio: number | null;
}

export function buildProfile(
  provider: TerrainProvider,
  a: LatLon & { antennaHeightAglM: number },
  b: LatLon & { antennaHeightAglM: number },
  opts: ProfileOptions,
): Profile {
  const dTotal = haversineDistanceM(a, b);
  const lambdaM = wavelengthM(opts.frequencyMhz);
  const target = opts.targetSpacingM ?? 30;
  const minSamples = opts.minSamples ?? 32;
  const maxSamples = opts.maxSamples ?? 2048;
  const n = Math.min(maxSamples, Math.max(minSamples, Math.ceil(dTotal / target) + 1));

  const aGround = provider.elevationAt(a);
  const bGround = provider.elevationAt(b);
  const aTop = aGround === null ? null : aGround + a.antennaHeightAglM;
  const bTop = bGround === null ? null : bGround + b.antennaHeightAglM;

  const points: ProfilePoint[] = [];
  let unknownCount = 0;
  let worstIndex: number | null = null;
  let worstRatio: number | null = null;

  for (let i = 0; i < n; i += 1) {
    const f = n === 1 ? 0 : i / (n - 1);
    const p = interpolateGreatCircle(a, b, f);
    const d1 = dTotal * f;
    const d2 = dTotal - d1;
    const bulge = earthBulgeM(d1, d2);
    const f1 = fresnelRadiusM(lambdaM, d1, d2);

    const ground = provider.elevationAt(p);
    const known = ground !== null && aTop !== null && bTop !== null;
    const groundM = ground;
    const lineHeightM = aTop !== null && bTop !== null ? aTop + (bTop - aTop) * f : Number.NaN;
    const clearanceM = known && groundM !== null ? lineHeightM - groundM - bulge : Number.NaN;

    if (!known) unknownCount += 1;

    points.push({
      distanceM: d1,
      terrainM: groundM,
      lineHeightM,
      earthBulgeAdjM: bulge,
      fresnelRadiusM: f1,
      clearanceM: known ? clearanceM : NaN,
    });

    // Worst point = minimum clearance ratio among interior known samples.
    if (known && i > 0 && i < n - 1 && f1 > 0) {
      const ratio = clearanceM / f1;
      if (worstRatio === null || ratio < worstRatio) {
        worstRatio = ratio;
        worstIndex = i;
      }
    }
  }

  return {
    points,
    totalDistanceM: dTotal,
    unknownCount,
    worstIndex,
    worstClearanceRatio: worstRatio,
  };
}
