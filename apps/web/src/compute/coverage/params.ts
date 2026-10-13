/**
 * Coverage-preview geometry. Shared by the CPU kernel and the WebGPU engine so
 * both derive cell centres identically (required for parity).
 *
 * The preview area is a square in Web-Mercator space centred on the site;
 * cell (x, y) centre -> global z12 pixel -> lon/lat. All constants live here.
 */
import { DEM_ZOOM, TILE_SIZE } from '../../lib/tilemath.js';

export const COVERAGE_HALF_SIZE_M = 25_000;
export const COVERAGE_DETAILS = { low: 128, medium: 256, high: 512 } as const;
export type CoverageDetail = keyof typeof COVERAGE_DETAILS;

/** Model/terrain revisions recorded in results (cache + parity keys). */
export const COVERAGE_MODEL_VERSION = 'rf-model-0.1.0/coverage-v1';
export const TERRAIN_REVISION = 'terrarium-os-terrain50-z12-v1';

export interface CoverageGeometry {
  /** Global z12 pixel coordinates of the area centre (site). */
  centerPx: { x: number; y: number };
  /** Half-size of the square in global z12 pixels. */
  halfPx: number;
  width: number;
  height: number;
  /** Global pixel size of one cell. */
  cellPx: number;
  /** [west, south, east, north] */
  bounds: [number, number, number, number];
  resolutionM: number;
}

const WORLD_PX = 2 ** DEM_ZOOM * TILE_SIZE; // 1,048,576

export function lonLatToGlobalPx(lon: number, lat: number): { x: number; y: number } {
  const x = ((lon + 180) / 360) * WORLD_PX;
  const latRad = (lat * Math.PI) / 180;
  const y = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * WORLD_PX;
  return { x, y };
}

export function globalPxToLonLat(x: number, y: number): { lon: number; lat: number } {
  const lon = (x / WORLD_PX) * 360 - 180;
  const n = Math.PI - 2 * Math.PI * (y / WORLD_PX);
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lon, lat };
}

export function coverageGeometry(site: { lat: number; lon: number }, detail: CoverageDetail): CoverageGeometry {
  const width = COVERAGE_DETAILS[detail];
  const height = width;
  const centerPx = lonLatToGlobalPx(site.lon, site.lat);
  // Ground metres per z12 pixel at this latitude.
  const mPerPx = (156543.03392 * Math.cos((site.lat * Math.PI) / 180)) / 2 ** DEM_ZOOM;
  const halfPx = COVERAGE_HALF_SIZE_M / mPerPx;
  const cellPx = (2 * halfPx) / width;
  const west = globalPxToLonLat(centerPx.x - halfPx, centerPx.y).lon;
  const east = globalPxToLonLat(centerPx.x + halfPx, centerPx.y).lon;
  const north = globalPxToLonLat(centerPx.x, centerPx.y - halfPx).lat;
  const south = globalPxToLonLat(centerPx.x, centerPx.y + halfPx).lat;
  return {
    centerPx,
    halfPx,
    width,
    height,
    cellPx,
    bounds: [west, south, east, north],
    resolutionM: (2 * COVERAGE_HALF_SIZE_M) / width,
  };
}

/** Cell-centre lon/lat — the single source of truth for both backends. */
export function cellCenterLonLat(geo: CoverageGeometry, cx: number, cy: number): { lon: number; lat: number } {
  const x = geo.centerPx.x - geo.halfPx + (cx + 0.5) * geo.cellPx;
  const y = geo.centerPx.y - geo.halfPx + (cy + 0.5) * geo.cellPx;
  return globalPxToLonLat(x, y);
}
