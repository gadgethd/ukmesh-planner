/**
 * Worker-side Terrarium DEM provider over /terrain-tiles/ (z ≤ 12).
 *
 * - tiles decoded to Float32 rasters, bounded cache (FIFO eviction)
 * - NODATA pixels are NaN; sampling fails closed (never substitute 0 m)
 * - `warmPath` preloads every tile a great-circle path crosses so assessLink
 *   never sees an unloaded tile as "missing terrain".
 */
import {
  bilinearSample,
  decodeTerrarium,
  haversineDistanceM,
  samplePath,
  TERRARIUM_NODATA,
  type ElevationRaster,
  type LatLon,
  type TerrainProvider,
} from '@ukmesh-planner/rf-core';
import {
  DEM_ZOOM,
  localTileCoords,
  lonLatToGlobalPx,
  TILE_SIZE,
  tileOfGlobalPx,
  tilesForPoints,
  type TileCoord,
} from '../lib/tilemath.js';

export const TERRAIN_REVISION = 'terrarium-os-terrain50-z12-v1';
const MAX_CACHED_TILES = 160;

export class TerrariumTileProvider implements TerrainProvider {
  readonly revision = TERRAIN_REVISION;
  private cache = new Map<string, ElevationRaster>();
  private inflight = new Map<string, Promise<ElevationRaster | null>>();
  /** Transient-failure bookkeeping: a tile that failed twice is treated as absent. */
  private failed = new Map<string, number>();

  constructor(private readonly baseUrl = '/terrain-tiles') {}

  private key(t: TileCoord): string {
    return `${t.z}/${t.x}/${t.y}`;
  }

  private async loadTile(t: TileCoord): Promise<ElevationRaster | null> {
    const key = this.key(t);
    const cached = this.cache.get(key);
    if (cached) return cached;
    if ((this.failed.get(key) ?? 0) >= 2) return null;
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<ElevationRaster | null> => {
      try {
        const res = await fetch(`${this.baseUrl}/${t.z}/${t.x}/${t.y}.png`);
        if (!res.ok) return null;
        const blob = await res.blob();
        const bmp = await createImageBitmap(blob);
        const canvas = new OffscreenCanvas(bmp.width, bmp.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return null;
        ctx.drawImage(bmp, 0, 0);
        const img = ctx.getImageData(0, 0, bmp.width, bmp.height);
        const data = new Float32Array(img.width * img.height);
        for (let i = 0; i < data.length; i += 1) {
          const v = decodeTerrarium(img.data[i * 4]!, img.data[i * 4 + 1]!, img.data[i * 4 + 2]!);
          data[i] = v === TERRARIUM_NODATA ? Number.NaN : v;
        }
        return { width: img.width, height: img.height, data };
      } catch {
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    const raster = await promise;
    if (raster === null) {
      // Never cache a failure permanently: transient network errors must not
      // poison the tile for the whole session. Retry once on next request.
      this.failed.set(key, (this.failed.get(key) ?? 0) + 1);
      return null;
    }
    this.failed.delete(key);
    if (this.cache.size >= MAX_CACHED_TILES) {
      const first = this.cache.keys().next().value;
      if (first !== undefined) this.cache.delete(first);
    }
    this.cache.set(key, raster);
    return raster;
  }

  elevationAt(p: LatLon): number | null {
    const { px, py } = lonLatToGlobalPx(p.lon, p.lat, DEM_ZOOM);
    const t = tileOfGlobalPx(px, py);
    const raster = this.cache.get(this.key({ z: DEM_ZOOM, ...t }));
    if (!raster) return null;
    const { lx, ly } = localTileCoords(px, py, t);
    return bilinearSample(raster, lx, ly);
  }

  async warmPoint(p: LatLon): Promise<void> {
    const { px, py } = lonLatToGlobalPx(p.lon, p.lat, DEM_ZOOM);
    await this.loadTile({ z: DEM_ZOOM, ...tileOfGlobalPx(px, py) });
  }

  async warmPath(a: LatLon, b: LatLon): Promise<void> {
    const n = Math.max(2, Math.ceil(haversineDistanceM(a, b) / 400) + 1);
    const tiles = tilesForPoints(samplePath(a, b, n), DEM_ZOOM);
    await Promise.all(tiles.map((t) => this.loadTile(t)));
  }

  /**
   * Assemble a tile-aligned elevation window (Float32Array, NaN = NODATA)
   * covering the given global-pixel rectangle plus a margin. Used to upload
   * terrain to the WebGPU engine; the buffer mirrors exactly what
   * `elevationAt` would sample from the same tiles (tile-local clamp included).
   */
  async windowRaster(
    minPx: { x: number; y: number },
    maxPx: { x: number; y: number },
    marginPx = 64,
  ): Promise<{ data: Float32Array; width: number; height: number; originX: number; originY: number } | null> {
    const tileMinX = Math.floor((minPx.x - marginPx) / TILE_SIZE);
    const tileMinY = Math.floor((minPx.y - marginPx) / TILE_SIZE);
    const tileMaxX = Math.floor((maxPx.x + marginPx) / TILE_SIZE);
    const tileMaxY = Math.floor((maxPx.y + marginPx) / TILE_SIZE);
    const tilesX = tileMaxX - tileMinX + 1;
    const tilesY = tileMaxY - tileMinY + 1;
    const width = tilesX * TILE_SIZE;
    const height = tilesY * TILE_SIZE;
    if (width * height * 4 > 96 * 1024 * 1024) return null; // bounded (96 MB f32)

    const originX = tileMinX * TILE_SIZE;
    const originY = tileMinY * TILE_SIZE;
    const data = new Float32Array(width * height);

    const loads: Array<Promise<void>> = [];
    for (let ty = tileMinY; ty <= tileMaxY; ty += 1) {
      for (let tx = tileMinX; tx <= tileMaxX; tx += 1) {
        loads.push(
          this.loadTile({ z: DEM_ZOOM, x: tx, y: ty }).then((raster) => {
            const ox = tx * TILE_SIZE - originX;
            const oy = ty * TILE_SIZE - originY;
            for (let y = 0; y < TILE_SIZE; y += 1) {
              const src = y * TILE_SIZE;
              const dst = (oy + y) * width + ox;
              if (raster) {
                data.set(raster.data.subarray(src, src + TILE_SIZE), dst);
              } else {
                data.fill(Number.NaN, dst, dst + TILE_SIZE);
              }
            }
          }),
        );
      }
    }
    await Promise.all(loads);
    return { data, width, height, originX, originY };
  }
}
