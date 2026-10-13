import { describe, expect, it } from 'vitest';
import { coverageGeometry, cellCenterLonLat, COVERAGE_DETAILS } from './params.js';
import { chooseCoverageBackend, isSoftwareAdapter, type GpuLike } from './select.js';
import { runCoverageCpu } from './kernel-cpu.js';
import { CELL_LIKELY, CELL_BLOCKED, CELL_UNKNOWN, CELL_OUT_OF_RANGE } from './codes.js';
import { DEFAULT_UK_RF_SETTINGS, type RfSettings } from '@ukmesh-planner/contracts';
import { haversineDistanceM, type LatLon, type TerrainProvider } from '@ukmesh-planner/rf-core';

describe('coverage geometry', () => {
  it('is centred on the site with a square in mercator space', () => {
    const geo = coverageGeometry({ lat: 54.97, lon: -1.61 }, 'low');
    expect(geo.width).toBe(COVERAGE_DETAILS.low);
    expect(geo.height).toBe(COVERAGE_DETAILS.low);
    expect(geo.resolutionM).toBeCloseTo(50_000 / COVERAGE_DETAILS.low, 6);
    // centre cell centre is within a cell of the site
    const c = cellCenterLonLat(geo, geo.width / 2, geo.height / 2);
    const d = haversineDistanceM({ lat: 54.97, lon: -1.61 }, c);
    expect(d).toBeLessThan(geo.resolutionM);
    // bounds are symmetric about the site
    expect((geo.bounds[0] + geo.bounds[2]) / 2).toBeCloseTo(-1.61, 3);
    // Mercator-square symmetry is exact in projected space; latitude midpoint
    // differs slightly because lat is non-linear in mercator y.
    expect((geo.bounds[1] + geo.bounds[3]) / 2).toBeCloseTo(54.97, 2);
  });
});

describe('backend selection', () => {
  const hw = (): GpuLike => ({
    requestAdapter: async () => ({
      isFallbackAdapter: false,
      info: { architecture: 'ampere', vendor: 'nvidia' },
      requestDevice: async () => ({}),
    }),
  });
  const sw = (): GpuLike => ({
    requestAdapter: async () => ({
      isFallbackAdapter: true,
      info: { architecture: 'swiftshader' },
      requestDevice: async () => ({}),
    }),
  });

  it('no navigator.gpu -> wasm', async () => {
    expect((await chooseCoverageBackend(undefined)).backend).toBe('wasm');
  });
  it('no adapter -> wasm', async () => {
    const gpu: GpuLike = { requestAdapter: async () => null };
    expect((await chooseCoverageBackend(gpu)).backend).toBe('wasm');
  });
  it('software adapter -> wasm unless forced', async () => {
    expect((await chooseCoverageBackend(sw())).backend).toBe('wasm');
    expect((await chooseCoverageBackend(sw(), { force: 'webgpu' })).backend).toBe('webgpu');
  });
  it('hardware adapter -> webgpu', async () => {
    expect((await chooseCoverageBackend(hw())).backend).toBe('webgpu');
  });
  it('device request failure -> wasm', async () => {
    const gpu: GpuLike = {
      requestAdapter: async () => ({
        requestDevice: async () => {
          throw new Error('device lost during creation');
        },
      }),
    };
    expect((await chooseCoverageBackend(gpu)).backend).toBe('wasm');
  });
  it('explicit forces win', async () => {
    expect((await chooseCoverageBackend(hw(), { force: 'cpu' })).backend).toBe('cpu');
    expect((await chooseCoverageBackend(hw(), { force: 'wasm' })).backend).toBe('wasm');
  });
  it('detects software adapters by info hints', () => {
    expect(isSoftwareAdapter({ info: { description: 'SwiftShader Device' } })).toBe(true);
    expect(isSoftwareAdapter({ info: { description: 'llvmpipe' } })).toBe(true);
    expect(isSoftwareAdapter({ info: { architecture: 'rdna3' } })).toBe(false);
  });
});

describe('cpu coverage kernel', () => {
  class SyntheticProvider implements TerrainProvider {
    readonly revision = 'synthetic-test';
    constructor(private readonly h: (lon: number, lat: number) => number | null) {}
    elevationAt(p: LatLon): number | null {
      return this.h(p.lon, p.lat);
    }
  }

  const rf: RfSettings = { ...DEFAULT_UK_RF_SETTINGS, maxRangeKm: 100 };
  const site = { lat: 54.97, lon: -1.61, antennaHeightAglM: 30 };

  it('flat plain: near cells are likely with healthy margins', async () => {
    const geo = coverageGeometry(site, 'low');
    const out = await runCoverageCpu({ site, geometry: geo, rf, provider: new SyntheticProvider(() => 50) });
    expect(out.counts[CELL_LIKELY] ?? 0).toBeGreaterThan(0.9 * geo.width * geo.height);
    const centre = Math.floor(geo.height / 2) * geo.width + Math.floor(geo.width / 2);
    expect(out.margins[centre]).toBeGreaterThan(60);
  });

  it('ridge exactly between site and cells blocks the far side', async () => {
    // A north-south ridge 1 km east of the site, 500 m high.
    const siteLon = site.lon;
    const provider = new SyntheticProvider((lon) => (lon > siteLon + 0.02 && lon < siteLon + 0.05 ? 500 : 50));
    const geo = coverageGeometry(site, 'low');
    const out = await runCoverageCpu({ site, geometry: geo, rf, provider });
    expect(out.counts[CELL_LIKELY] ?? 0).toBeGreaterThan(0);
    expect(out.counts[CELL_BLOCKED] ?? 0).toBeGreaterThan(0);
  });

  it('unknown terrain propagates per cell', async () => {
    const provider = new SyntheticProvider((lon) => (lon < site.lon - 0.02 ? null : 50));
    const geo = coverageGeometry(site, 'low');
    const out = await runCoverageCpu({ site, geometry: geo, rf, provider });
    expect(out.counts[CELL_UNKNOWN] ?? 0).toBeGreaterThan(0);
  });

  it('range cutoff marks out-of-range cells without assessment', async () => {
    const geo = coverageGeometry(site, 'low');
    const total = geo.width * geo.height;
    const out = await runCoverageCpu({ site, geometry: geo, rf: { ...rf, maxRangeKm: 5 }, provider: new SyntheticProvider(() => 50) });
    // A 5 km circle covers only a few percent of the 50x50 km box.
    expect(out.counts[CELL_OUT_OF_RANGE] ?? 0).toBeGreaterThan(0.9 * total);
    expect(out.counts[CELL_LIKELY] ?? 0).toBeGreaterThan(0);
    expect((out.counts[CELL_OUT_OF_RANGE] ?? 0) + (out.counts[CELL_LIKELY] ?? 0)).toBe(total);
  });

  it('is deterministic', async () => {
    const geo = coverageGeometry(site, 'low');
    const a = await runCoverageCpu({ site, geometry: geo, rf, provider: new SyntheticProvider(() => 120) });
    const b = await runCoverageCpu({ site, geometry: geo, rf, provider: new SyntheticProvider(() => 120) });
    expect(Array.from(a.codes)).toEqual(Array.from(b.codes));
  });
});
