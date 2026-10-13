/**
 * CPU coverage kernel — the parity oracle for the WebGPU engine.
 *
 * Runs the same rf-core pipeline as the Simple-journey assess worker, once
 * per raster cell, with the documented coverage sampling parameters. Executed
 * inside the coverage worker (never on the main thread, never on the VPS).
 */
import { assessLink, haversineDistanceM, type LatLon, type TerrainProvider } from '@ukmesh-planner/rf-core';
import type { RfSettings } from '@ukmesh-planner/contracts';
import { cellCenterLonLat, type CoverageGeometry } from './params.js';
import { CELL_LIKELY, CELL_MARGINAL, CELL_UNLIKELY, CELL_BLOCKED, CELL_UNKNOWN, CELL_OUT_OF_RANGE } from './codes.js';

export interface CoverageKernelInput {
  site: { lat: number; lon: number; antennaHeightAglM: number };
  geometry: CoverageGeometry;
  rf: RfSettings;
  provider: TerrainProvider & {
    warmPath?: (
      a: LatLon,
      b: LatLon,
      opts?: { targetSpacingM?: number; minSamples?: number; maxSamples?: number },
    ) => Promise<void>;
  };
  maxSamples?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface CoverageKernelOutput {
  margins: Float32Array;
  codes: Uint8Array;
  /** counts per cell code index (0..5). */
  counts: number[];
  elapsedMs: number;
}

const CLASSIFICATION_TO_CODE: Record<string, number> = {
  likely: CELL_LIKELY,
  marginal: CELL_MARGINAL,
  unlikely: CELL_UNLIKELY,
  blocked: CELL_BLOCKED,
  'unknown-terrain': CELL_UNKNOWN,
};

export async function runCoverageCpu(input: CoverageKernelInput): Promise<CoverageKernelOutput> {
  const { site, geometry, rf, provider } = input;
  const { width, height } = geometry;
  const total = width * height;
  const margins = new Float32Array(total);
  margins.fill(Number.NaN);
  const codes = new Uint8Array(total);
  const counts = [0, 0, 0, 0, 0, 0];
  const t0 = performance.now();

  const profile = { targetSpacingM: 90, minSamples: 24, maxSamples: input.maxSamples ?? 512 };
  const source = { id: 'planned', lat: site.lat, lon: site.lon, antennaHeightAglM: site.antennaHeightAglM };

  let i = 0;
  for (let cy = 0; cy < height; cy += 1) {
    for (let cx = 0; cx < width; cx += 1, i += 1) {
      const cell = cellCenterLonLat(geometry, cx, cy);
      if (haversineDistanceM(source, cell) / 1000 > rf.maxRangeKm) {
        codes[i] = CELL_OUT_OF_RANGE;
        counts[CELL_OUT_OF_RANGE] = (counts[CELL_OUT_OF_RANGE] ?? 0) + 1;
        continue;
      }
      if (provider.warmPath) await provider.warmPath(source, cell, profile);
      const r = assessLink({
        provider,
        source,
        target: { id: 'cell', lat: cell.lat, lon: cell.lon, antennaHeightAglM: rf.rxHeightAglM },
        rf,
        profile,
      });
      const code = CLASSIFICATION_TO_CODE[r.classification] ?? CELL_UNKNOWN;
      codes[i] = code;
      counts[code] = (counts[code] ?? 0) + 1;
      margins[i] = r.marginDb === null ? Number.NaN : r.marginDb;
    }
    if (cy % 8 === 7 || cy === height - 1) input.onProgress?.(Math.min((cy + 1) * width, total), total);
  }

  return { margins, codes, counts, elapsedMs: performance.now() - t0 };
}
