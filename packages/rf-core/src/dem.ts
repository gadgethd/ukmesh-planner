/**
 * Terrarium elevation encoding + raster sampling helpers.
 *
 * Terrarium (Mapzen/AWS elevation-tiles-prod): elevation metres =
 *   (R * 256 + G + B / 256) − 32768
 * NODATA is represented as NaN in decoded rasters.
 */

export const TERRARIUM_NODATA = -32768;

/** Decode one terrarium pixel to elevation metres. */
export function decodeTerrarium(r: number, g: number, b: number): number {
  return r * 256 + g + b / 256 - 32768;
}

/** Encode elevation metres back to RGB (fixtures/tests only). */
export function encodeTerrarium(elevationM: number): [number, number, number] {
  const v = Math.round((elevationM + 32768) * 256);
  const r = (v >> 16) & 0xff;
  const g = (v >> 8) & 0xff;
  const b = v & 0xff;
  return [r, g, b];
}

export interface ElevationRaster {
  width: number;
  height: number;
  /** Elevations in metres, row-major, NaN = unknown. */
  data: Float32Array;
}

export function isKnownElevation(v: number | null | undefined): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v !== TERRARIUM_NODATA;
}

/**
 * Bilinear sample. x/y are in pixel coordinates where (0,0) is the centre of
 * the top-left pixel; x spans [0, width-1], y spans [0, height-1].
 * Returns null when any contributing pixel is unknown (fail closed — never
 * substitute 0 m and claim clear LOS).
 */
export function bilinearSample(raster: ElevationRaster, x: number, y: number): number | null {
  if (x < 0 || y < 0 || x > raster.width - 1 || y > raster.height - 1) return null;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, raster.width - 1);
  const y1 = Math.min(y0 + 1, raster.height - 1);
  const fx = x - x0;
  const fy = y - y0;
  const corners: Array<[number, number]> = [
    [x0, y0],
    [x1, y0],
    [x0, y1],
    [x1, y1],
  ];
  const values: number[] = [];
  for (const [cx, cy] of corners) {
    const v = raster.data[cy * raster.width + cx];
    if (v === undefined) return null;
    values.push(v);
  }
  const [v00, v10, v01, v11] = values as [number, number, number, number];
  if (!values.every((v) => isKnownElevation(v))) return null;
  const top = v00 * (1 - fx) + v10 * fx;
  const bottom = v01 * (1 - fx) + v11 * fx;
  return top * (1 - fy) + bottom * fy;
}

/** Nearest-neighbour fallback (labelled as lower precision by callers). */
export function nearestSample(raster: ElevationRaster, x: number, y: number): number | null {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= raster.width || yi >= raster.height) return null;
  const v = raster.data[yi * raster.width + xi];
  return isKnownElevation(v) ? v : null;
}
