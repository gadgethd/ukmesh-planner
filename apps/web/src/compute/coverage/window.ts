/** Immutable DEM window shared by the GPU, WASM and CPU retry of a job. */
import type { LatLon, TerrainProvider } from '@ukmesh-planner/rf-core';
import { DEM_ZOOM, lonLatToGlobalPx, TILE_SIZE } from '../../lib/tilemath.js';
import type { WasmDem } from '../wasm/backend.js';

export class WindowTerrainProvider implements TerrainProvider {
  constructor(private readonly dem: WasmDem, readonly revision: string) {}

  elevationAt(p: LatLon): number | null {
    const { px, py } = lonLatToGlobalPx(p.lon, p.lat, DEM_ZOOM);
    const tx = Math.floor(px / TILE_SIZE) * TILE_SIZE;
    const ty = Math.floor(py / TILE_SIZE) * TILE_SIZE;
    const lx = Math.min(255, Math.max(0, px - tx));
    const ly = Math.min(255, Math.max(0, py - ty));
    const x0 = Math.floor(lx), y0 = Math.floor(ly);
    const x1 = Math.min(x0 + 1, 255), y1 = Math.min(y0 + 1, 255);
    const sample = (x: number, y: number): number => {
      const dx = tx + x - this.dem.originX, dy = ty + y - this.dem.originY;
      if (dx < 0 || dy < 0 || dx >= this.dem.width || dy >= this.dem.height) return Number.NaN;
      return this.dem.data[dy * this.dem.width + dx]!;
    };
    const values = [sample(x0, y0), sample(x1, y0), sample(x0, y1), sample(x1, y1)];
    if (!values.every(Number.isFinite)) return null;
    const fx = lx - x0, fy = ly - y0;
    return (values[0]! * (1 - fx) + values[1]! * fx) * (1 - fy)
      + (values[2]! * (1 - fx) + values[3]! * fx) * fy;
  }
}
