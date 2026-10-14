/**
 * Worker-side Terrarium DEM provider over /terrain-tiles/ (z ≤ 12).
 *
 * - tiles decoded to Float32 rasters, bounded cache (FIFO eviction)
 * - NODATA pixels are NaN; sampling fails closed (never substitute 0 m)
 * - `warmPath` preloads every tile the subsequent buildProfile call will
 *   sample (same spacing/limits => identical sample positions), so assessLink "missing terrain".
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
// 320 tiles ~ 84 MB of f32 rasters: enough that a full candidate run
// (~200 paths x up to ~35 tiles) stops thrashing the cache (Ben 2026-10-14
// spurious missing-terrain exclusions traced to cache churn on long paths).
const MAX_CACHED_TILES = 320;

export class TerrariumTileProvider implements TerrainProvider {
  readonly revision = TERRAIN_REVISION;
  private cache = new Map<string, ElevationRaster>();
  private inflight = new Map<string, Promise<ElevationRaster | null>>();
  /**
   * Transient-failure bookkeeping: a tile that keeps failing is treated as
   * absent for a short COOLDOWN only (never permanently — a transient network
   * blip must not poison the tile for the session; that surfaced as spurious
   * "missing terrain" path exclusions, Ben 2026-10-14).
   */
  private failed = new Map<string, { count: number; at: number }>();
  private static readonly FAILURE_COOLDOWN_MS = 15_000;

  constructor(private readonly baseUrl = '/terrain-tiles') {}

  private key(t: TileCoord): string {
    return `${t.z}/${t.x}/${t.y}`;
  }

  private async loadTile(t: TileCoord): Promise<ElevationRaster | null> {
    const key = this.key(t);
    const cached = this.cache.get(key);
    if (cached) return cached;
    const f = this.failed.get(key);
    if (f && f.count >= 2 && Date.now() - f.at < TerrariumTileProvider.FAILURE_COOLDOWN_MS) {
      return null;
    }
    const existing = this.inflight.get(key);
    if (existing) return existing;

    const promise = (async (): Promise<ElevationRaster | null> => {
      try {
        // Retry transient failures (network blips, throttling): a single
        // failed fetch used to exclude whole paths as "missing terrain".
        for (let attempt = 0; attempt < 3; attempt += 1) {
          try {
            const res = await fetch(`${this.baseUrl}/${t.z}/${t.x}/${t.y}.png`);
            if (!res.ok) {
              await new Promise((r) => setTimeout(r, 150 * (attempt + 1) * (attempt + 1)));
              continue;
            }
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
            await new Promise((r) => setTimeout(r, 150 * (attempt + 1) * (attempt + 1)));
          }
        }
        return null;
      } finally {
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    const raster = await promise;
    if (raster === null) {
      // Never cache a failure permanently: brief cooldown, then retryable.
      const prev = this.failed.get(key);
      this.failed.set(key, { count: (prev?.count ?? 0) + 1, at: Date.now() });
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

  async warmPath(
    a: LatLon,
    b: LatLon,
    opts?: { targetSpacingM?: number; minSamples?: number; maxSamples?: number },
  ): Promise<void> {
    // Sample at exactly the spacing the following buildProfile call uses:
    // same n => same interpolateGreatCircle f values => identical sample
    // positions => every tile the profile touches is loaded. Coarser
    // sampling can skip a tile the path only corner-clips (<400 m inside),
    // which would surface as spurious "unknown terrain" cells.
    const target = opts?.targetSpacingM ?? 30;
    const minSamples = opts?.minSamples ?? 32;
    const maxSamples = opts?.maxSamples ?? 2048;
    const n = Math.min(maxSamples, Math.max(minSamples, Math.ceil(haversineDistanceM(a, b) / target) + 1));
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
