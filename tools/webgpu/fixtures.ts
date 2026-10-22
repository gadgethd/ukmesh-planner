/** Offline, synthetic and versioned: no live tiles, snapshots or credentials. */
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import { coverageGeometry, globalPxToLonLat, type CoverageGeometry } from '../../apps/web/src/compute/coverage/params.js';
import { WindowTerrainProvider } from '../../apps/web/src/compute/coverage/window.js';
import { CODE_RGBA } from '../../apps/web/src/compute/coverage/codes.js';
import type { CoverageGpuInput } from '../../apps/web/src/compute/coverage/webgpu.js';

export const FIXTURE_VERSION = 'coverage-synthetic-v1';
export const FIXTURE_NAMES = ['flat', 'ridge', 'hills', 'coast', 'missing-dem', 'range-cutoff', 'raised-mast', 'high-latitude', 'low-budget'] as const;
export type FixtureName = typeof FIXTURE_NAMES[number];
export const FIXTURE_CAMERA = { width: 512, height: 512, bearing: 0, pitch: 0 };

export function makeFixture(name: FixtureName, size = 32, halfSizeM = 25_000): CoverageGpuInput & { provider: WindowTerrainProvider } {
  const site = { lat: name === 'high-latitude' ? 59.1 : 54.9648, lon: -1.6237, antennaHeightAglM: name === 'raised-mast' || name === 'low-budget' ? 80 : 2 };
  const base = coverageGeometry(site, 'low');
  base.halfPx *= halfSizeM / 25_000;
  const nw = globalPxToLonLat(base.centerPx.x - base.halfPx, base.centerPx.y - base.halfPx);
  const se = globalPxToLonLat(base.centerPx.x + base.halfPx, base.centerPx.y + base.halfPx);
  base.bounds = [nw.lon, se.lat, se.lon, nw.lat];
  const geometry: CoverageGeometry = { ...base, width: size, height: size, cellPx: 2 * base.halfPx / size, resolutionM: 2 * halfSizeM / size };
  const originX = Math.floor((base.centerPx.x - base.halfPx - 64) / 256) * 256;
  const originY = Math.floor((base.centerPx.y - base.halfPx - 64) / 256) * 256;
  const width = (Math.floor((base.centerPx.x + base.halfPx + 64) / 256) + 1) * 256 - originX;
  const height = (Math.floor((base.centerPx.y + base.halfPx + 64) / 256) + 1) * 256 - originY;
  const data = new Float32Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const dx = (originX + x - base.centerPx.x) / base.halfPx;
      const dy = (originY + y - base.centerPx.y) / base.halfPx;
      let v = 50;
      if (name === 'ridge' || name === 'raised-mast') v += 250 * Math.exp(-(((dx - 0.22) / 0.08) ** 2));
      if (name === 'hills' || name === 'high-latitude') {
        // Fixed smooth hills with unequal axes detect shifted/rotated sampling.
        v += 140 * Math.exp(-(((dx + 0.3) / 0.15) ** 2) - ((dy - 0.2) / 0.4) ** 2)
          + 90 * Math.exp(-(((dx - 0.45) / 0.2) ** 2) - ((dy + 0.3) / 0.2) ** 2);
      }
      if (name === 'coast') v = Math.max(0, 90 * (dx + 0.3)); // valid sea level is not NODATA
      if (name === 'missing-dem' && dx > 0.4 && dx < 0.7) v = Number.NaN;
      data[y * width + x] = v;
    }
  }
  const dem = { data, width, height, originX, originY };
  const provider = new WindowTerrainProvider(dem, FIXTURE_VERSION);
  const rf = { ...DEFAULT_UK_RF_SETTINGS, maxRangeKm: name === 'range-cutoff' ? 5 : 100,
    ...(name === 'low-budget' ? { txPowerDbm: -8, rxHeightAglM: 20 } : {}) };
  const siteTopM = (provider.elevationAt(site) ?? Number.NaN) + site.antennaHeightAglM;
  return { site, geometry, rf, siteTopM, dem, provider };
}

export function rgba(codes: Uint8Array): Uint8ClampedArray<ArrayBuffer> {
  const pixels = new Uint8ClampedArray(codes.length * 4);
  codes.forEach((c, i) => pixels.set(CODE_RGBA[c]!, i * 4));
  return pixels;
}

export async function hashBytes(bytes: Uint8Array | Uint8ClampedArray): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return Array.from(new Uint8Array(hash), (v) => v.toString(16).padStart(2, '0')).join('');
}

/** Canonical margins: millidecibels, explicit null for unknown/range cells. */
export async function outputHashes(out: { codes: Uint8Array; margins: Float32Array }): Promise<{ codes: string; rgba: string; margins: string }> {
  return {
    codes: await hashBytes(out.codes), rgba: await hashBytes(rgba(out.codes)),
    margins: await hashBytes(new TextEncoder().encode(JSON.stringify(Array.from(out.margins, (v) => Number.isFinite(v) ? Math.round(v * 1000) : null)))),
  };
}

export function compareParity(cpu: { margins: Float32Array; codes: Uint8Array }, gpu: { margins: Float32Array; codes: Uint8Array }) {
  if (cpu.codes.length !== gpu.codes.length || cpu.margins.length !== gpu.margins.length) throw new Error('output dimensions differ');
  let finite = 0, sum = 0, max = 0, masks = 0, classes = 0, unexplained = 0, pixelChannels = 0;
  const boundaryCells: Array<{ index: number; cpu: number; gpu: number; cpuDb: number; gpuDb: number }> = [];
  const nearThreshold = (v: number): boolean => [5, 15].some((t) => Math.abs(v - t) <= 2);
  const cpuPixels = rgba(cpu.codes), gpuPixels = rgba(gpu.codes);
  for (let i = 0; i < cpu.codes.length; i += 1) {
    const a = cpu.margins[i]!, b = gpu.margins[i]!;
    if (Number.isFinite(a) !== Number.isFinite(b)) masks += 1;
    if (Number.isFinite(a) && Number.isFinite(b)) {
      finite += 1;
      const delta = Math.abs(a - b); sum += delta; max = Math.max(max, delta);
    }
    if (cpu.codes[i] !== gpu.codes[i]) {
      classes += 1;
      boundaryCells.push({ index: i, cpu: cpu.codes[i]!, gpu: gpu.codes[i]!, cpuDb: a, gpuDb: b });
      // Unknown/range mismatches are always failures. Boundary exceptions apply
      // only to RF classes and retain the previously documented numeric limit.
      if (cpu.codes[i]! >= 4 || gpu.codes[i]! >= 4 || !Number.isFinite(a) || !Number.isFinite(b)
          || !(Math.abs(a - b) <= 7 || nearThreshold(a) || nearThreshold(b))) unexplained += 1;
    }
  }
  for (let i = 0; i < cpuPixels.length; i += 1) if (cpuPixels[i] !== gpuPixels[i]) pixelChannels += 1;
  const meanDeltaDb = finite ? sum / finite : 0;
  return { cells: cpu.codes.length, finite, meanDeltaDb, maxDeltaDb: max, maskMismatches: masks,
    classificationMismatches: classes, boundaryCells, unexplainedMismatches: unexplained, pixelChannels,
    pass: masks === 0 && unexplained === 0 && meanDeltaDb <= 0.3 && classes / cpu.codes.length <= 0.0025 };
}
