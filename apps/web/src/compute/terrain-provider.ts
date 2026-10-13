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
}
