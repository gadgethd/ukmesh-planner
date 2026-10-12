/**
 * Geodesic helpers — spherical-earth model, adequate for UK-scale paths
 * (≤ a few hundred km). Documented limitation: no ellipsoidal correction;
 * error is < 0.5 % at these distances.
 */

export interface LatLon {
  lat: number;
  lon: number;
}

export const EARTH_RADIUS_M = 6_371_008.8;

/** Standard radio-engineering effective radius: 4/3 × true earth radius. */
export const EFFECTIVE_EARTH_RADIUS_M = (EARTH_RADIUS_M * 4) / 3;

export const toRad = (deg: number): number => (deg * Math.PI) / 180;
export const toDeg = (rad: number): number => (rad * 180) / Math.PI;

function normalizeLon(lon: number): number {
  let l = lon;
  while (l > 180) l -= 360;
  while (l < -180) l += 360;
  return l;
}

/** Great-circle distance in metres (haversine). */
export function haversineDistanceM(a: LatLon, b: LatLon): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dPhi = toRad(b.lat - a.lat);
  const dLambda = toRad(normalizeLon(b.lon - a.lon));
  const s =
    Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Initial bearing from a to b in degrees (0–360). */
export function initialBearingDeg(a: LatLon, b: LatLon): number {
  const phi1 = toRad(a.lat);
  const phi2 = toRad(b.lat);
  const dLambda = toRad(normalizeLon(b.lon - a.lon));
  const y = Math.sin(dLambda) * Math.cos(phi2);
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

/**
 * Point at fraction f (0..1) along the great circle from a to b (slerp).
 * Used to sample terrain profiles between two endpoints.
 */
export function interpolateGreatCircle(a: LatLon, b: LatLon, f: number): LatLon {
  const phi1 = toRad(a.lat);
  const lambda1 = toRad(a.lon);
  const phi2 = toRad(b.lat);
  const lambda2 = toRad(b.lon);
  const d = haversineDistanceM(a, b) / EARTH_RADIUS_M;
  if (d === 0) return { lat: a.lat, lon: a.lon };
  const sinD = Math.sin(d);
  const A = Math.sin((1 - f) * d) / sinD;
  const B = Math.sin(f * d) / sinD;
  const x = A * Math.cos(phi1) * Math.cos(lambda1) + B * Math.cos(phi2) * Math.cos(lambda2);
  const y = A * Math.cos(phi1) * Math.sin(lambda1) + B * Math.cos(phi2) * Math.sin(lambda2);
  const z = A * Math.sin(phi1) + B * Math.sin(phi2);
  return {
    lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
    lon: normalizeLon(toDeg(Math.atan2(y, x))),
  };
}

/** n evenly spaced samples (inclusive of both endpoints). */
export function samplePath(a: LatLon, b: LatLon, n: number): LatLon[] {
  if (n < 2) throw new Error('samplePath requires n >= 2');
  const out: LatLon[] = [];
  for (let i = 0; i < n; i += 1) out.push(interpolateGreatCircle(a, b, i / (n - 1)));
  return out;
}
