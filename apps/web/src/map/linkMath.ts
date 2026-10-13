/**
 * Pure math for the 3D link layer: converts real-world positions into the
 * scene's local metre frame (east/north/up) anchored at an origin point.
 *
 * The custom layer renders through MapLibre's mercator matrix, so a scene
 * unit must equal one metre *in mercator space* at the origin's latitude.
 * Converting via MercatorCoordinate deltas keeps endpoints exactly on their
 * true mercator positions (no accumulated projection error).
 */
import { MercatorCoordinate } from 'maplibre-gl';

export interface LonLatAlt {
  lon: number;
  lat: number;
  /** Real altitude in metres above sea level (visual exaggeration applied separately). */
  altM: number;
}

export interface SceneOrigin {
  /** Mercator x/y of the origin at altitude 0. */
  x: number;
  y: number;
  /** Mercator units per metre at the origin's latitude. */
  unitsPerMetre: number;
}

export function sceneOrigin(lon: number, lat: number): SceneOrigin {
  const mc = MercatorCoordinate.fromLngLat({ lng: lon, lat }, 0);
  return { x: mc.x, y: mc.y, unitsPerMetre: mc.meterInMercatorCoordinateUnits() };
}

/**
 * Scene-frame offset in metres: x = east, y = north, z = up. Altitudes are
 * multiplied by `exaggeration` so they share the visual vertical scale of
 * MapLibre terrain (which renders DEM heights × exaggeration).
 */
export function sceneOffset(origin: SceneOrigin, p: LonLatAlt, exaggeration = 1): [number, number, number] {
  const mc = MercatorCoordinate.fromLngLat({ lng: p.lon, lat: p.lat }, p.altM * exaggeration);
  const s = origin.unitsPerMetre;
  return [(mc.x - origin.x) / s, -(mc.y - origin.y) / s, (mc.z - 0) / s];
}
