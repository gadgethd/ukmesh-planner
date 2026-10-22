/**
 * WASM core vs CPU oracle parity, over identical synthetic windows.
 *
 * Both sides read the same DEM window with the same tile-local clamp and
 * bilinear semantics (the test provider mirrors TerrariumTileProvider), so
 * any divergence is in the ported math itself. f64 on both sides => expected
 * agreement is near-exact.
 *
 * The .wasm asset is produced by `npm run build:wasm` (also wired as the
 * web package's pretest/prebuild hook).
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS, type RfSettings } from '@ukmesh-planner/contracts';
import { haversineDistanceM, type LatLon, type TerrainProvider } from '@ukmesh-planner/rf-core';
import { coverageGeometry, cellCenterLonLat, type CoverageGeometry } from '../coverage/params.js';
import { runCoverageCpu } from '../coverage/kernel-cpu.js';
import { DEM_ZOOM, localTileCoords, lonLatToGlobalPx, TILE_SIZE, tileOfGlobalPx } from '../../lib/tilemath.js';
import { WasmCoverageCore } from './backend.js';

const SITE = { lat: 54.9648, lon: -1.6237, antennaHeightAglM: 2 };
const RF: RfSettings = { ...DEFAULT_UK_RF_SETTINGS };

/** Provider over a pre-assembled window — same semantics as the real provider. */
class WindowProvider implements TerrainProvider {
  readonly revision = 'test-window';
  constructor(
    private readonly data: Float32Array,
    private readonly width: number,
    private readonly height: number,
    private readonly originX: number,
    private readonly originY: number,
  ) {}

  elevationAt(p: LatLon): number | null {
    const { px, py } = lonLatToGlobalPx(p.lon, p.lat, DEM_ZOOM);
    const t = tileOfGlobalPx(px, py);
    const { lx, ly } = localTileCoords(px, py, t);
    const x0 = Math.floor(lx);
    const y0 = Math.floor(ly);
    const x1 = Math.min(x0 + 1, TILE_SIZE - 1);
    const y1 = Math.min(y0 + 1, TILE_SIZE - 1);
    const ox = t.x * TILE_SIZE - this.originX;
    const oy = t.y * TILE_SIZE - this.originY;
    const v = (ix: number, iy: number): number => this.data[(oy + iy) * this.width + (ox + ix)]!;
    const vals = [v(x0, y0), v(x1, y0), v(x0, y1), v(x1, y1)];
    if (vals.some((vv) => !Number.isFinite(vv))) return null;
    const fx = lx - x0;
    const fy = ly - y0;
    return (vals[0]! * (1 - fx) + vals[1]! * fx) * (1 - fy) + (vals[2]! * (1 - fx) + vals[3]! * fx) * fy;
  }
}

function makeWindow(geometry: CoverageGeometry): { data: Float32Array; width: number; height: number; originX: number; originY: number } {
  const margin = 64;
  const minX = Math.floor((geometry.centerPx.x - geometry.halfPx - margin) / TILE_SIZE) * TILE_SIZE;
  const minY = Math.floor((geometry.centerPx.y - geometry.halfPx - margin) / TILE_SIZE) * TILE_SIZE;
  const maxX = Math.floor((geometry.centerPx.x + geometry.halfPx + margin) / TILE_SIZE) * TILE_SIZE + TILE_SIZE;
  const maxY = Math.floor((geometry.centerPx.y + geometry.halfPx + margin) / TILE_SIZE) * TILE_SIZE + TILE_SIZE;
  const width = maxX - minX;
  const height = maxY - minY;
  const data = new Float32Array(width * height);
  const cx = geometry.centerPx.x - minX;
  const cy = geometry.centerPx.y - minY;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Base slope + a ridge west of the site + a small nodata patch far east.
      const ridge = 120 * Math.exp(-(((x - cx + 180) * (x - cx + 180)) / (2 * 45 * 45)));
      let v = 45 + (x - cx) * 0.02 + ridge;
      if (x > cx + 500 && x < cx + 516 && y > cy + 300 && y < cy + 316) v = Number.NaN;
      data[y * width + x] = v;
    }
  }
  return { data, width, height, originX: minX, originY: minY };
}

describe('wasm coverage core parity vs the CPU oracle', () => {
  it('matches margins and classifications over an identical window', async () => {
    const geometry = coverageGeometry(SITE, 'low');
    const win = makeWindow(geometry);
    const provider = new WindowProvider(win.data, win.width, win.height, win.originX, win.originY);
    const siteTopM = (provider.elevationAt(SITE) ?? 0) + SITE.antennaHeightAglM;

    const cpu = await runCoverageCpu({ site: SITE, geometry, rf: RF, provider });

    const bytes = readFileSync(new URL('../../../public/wasm/coverage-core.wasm', import.meta.url));
    const core = await WasmCoverageCore.fromBytes(bytes);
    const wasm = core.run({ site: SITE, geometry, rf: RF, siteTopM, dem: win });

    // Code agreement should be exact; margins near-exact (both f64).
    let mismatches = 0;
    let maxDelta = 0;
    const total = geometry.width * geometry.height;
    for (let i = 0; i < total; i += 1) {
      const a = wasm.margins[i]!;
      const b = cpu.margins[i]!;
      const aNaN = a !== a;
      const bNaN = b !== b;
      if (aNaN !== bNaN) mismatches += 1;
      else if (!aNaN && Math.abs(a - b) > maxDelta) maxDelta = Math.abs(a - b);
      if (wasm.codes[i] !== cpu.codes[i]) mismatches += 1;
    }
    expect(mismatches).toBe(0);
    expect(maxDelta).toBeLessThan(0.01);

    // Sanity: the synthetic ridge must produce a mix of classifications.
    const codes = new Set(Array.from(cpu.codes));
    expect(codes.size).toBeGreaterThan(1);
  }, 60_000); // heavy integration test (two full 128x128 runs)
});

it('reuses allocated WASM scratch memory instead of leaking it on every job', async () => {
  const bytes = readFileSync(new URL('../../../public/wasm/coverage-core.wasm', import.meta.url));
  const { instance } = await WebAssembly.instantiate(bytes, { env: { abort: () => { throw new Error('abort'); } } });
  const ex = instance.exports as unknown as { memory: WebAssembly.Memory; allocDem(n: number): number;
    allocMargins(n: number): number; allocCodes(n: number): number; allocParams(): number };
  const dem = ex.allocDem(262144), margins = ex.allocMargins(16384), codes = ex.allocCodes(16384), params = ex.allocParams();
  const byteLength = ex.memory.buffer.byteLength;
  for (let i = 0; i < 20; i += 1) {
    expect(ex.allocDem(262144 - i)).toBe(dem); expect(ex.allocMargins(16384)).toBe(margins);
    expect(ex.allocCodes(16384)).toBe(codes); expect(ex.allocParams()).toBe(params);
    expect(ex.memory.buffer.byteLength).toBe(byteLength);
  }
  // Growth reserves capacity: adjacent window sizes do not allocate repeatedly.
  const grown = ex.allocDem(262145);
  expect(ex.allocDem(262146)).toBe(grown);
});
