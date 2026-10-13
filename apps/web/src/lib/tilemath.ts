/**
 * Slippy-tile math for the Terrarium DEM tiles served at /terrain-tiles/
 * (z 0–12). Kept dependency-free and pure so it is unit-testable outside the
 * worker.
 */
export const DEM_ZOOM = 12;
export const TILE_SIZE = 256;

export interface TileCoord {
  z: number;
  x: number;
  y: number;
}

/** Global pixel coordinates at a zoom (origin = top-left of tile 0/0). */
export function lonLatToGlobalPx(lon: number, lat: number, z = DEM_ZOOM): { px: number; py: number } {
  const n = 2 ** z * TILE_SIZE;
  const px = ((lon + 180) / 360) * n;
  const latRad = (lat * Math.PI) / 180;
  const py = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
  return { px, py };
}

export function tileOfGlobalPx(px: number, py: number): { x: number; y: number } {
  return { x: Math.floor(px / TILE_SIZE), y: Math.floor(py / TILE_SIZE) };
}

/**
 * Local pixel coordinates within a tile, clamped to the addressable range
 * [0, TILE_SIZE-1]. Profile samples land in [0, TILE_SIZE); without the clamp
 * every sample in the outer 1-px band of a tile's right/bottom edge would be
 * rejected by bilinearSample as out of range (observed as spurious
 * "missing terrain" on ~half of all paths).
 */
export function localTileCoords(
  px: number,
  py: number,
  tile: { x: number; y: number },
): { lx: number; ly: number } {
  return {
    lx: Math.min(Math.max(px - tile.x * TILE_SIZE, 0), TILE_SIZE - 1),
    ly: Math.min(Math.max(py - tile.y * TILE_SIZE, 0), TILE_SIZE - 1),
  };
}

/** Distinct tiles crossed by a set of sample points. */
export function tilesForPoints(
  points: ReadonlyArray<{ lat: number; lon: number }>,
  z = DEM_ZOOM,
): TileCoord[] {
  const seen = new Set<string>();
  const out: TileCoord[] = [];
  for (const p of points) {
    const { px, py } = lonLatToGlobalPx(p.lon, p.lat, z);
    const t = tileOfGlobalPx(px, py);
    const key = `${z}/${t.x}/${t.y}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push({ z, x: t.x, y: t.y });
    }
  }
  return out;
}
