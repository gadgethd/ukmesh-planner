/**
 * Simple-journey compute worker — tier A (immediate point-to-point).
 *
 * Runs entirely in the visitor's browser; the VPS never performs RF math.
 * Protocol mirrors the shared compute contract (build brief §6.3): the same
 * request/result shapes will be reused by the WebGPU tier at Stage 4.
 */
import { assessLink, type LinkResult } from '@ukmesh-planner/rf-core';
import type { RfSettings } from '@ukmesh-planner/contracts';
import { TerrariumTileProvider } from './terrain-provider.js';

export interface AssessCandidate {
  id: string;
  name: string | null;
  lat: number;
  lon: number;
}

export interface AssessRequest {
  type: 'assess';
  jobId: number;
  site: { lat: number; lon: number; antennaHeightAglM: number };
  candidates: AssessCandidate[];
  rf: RfSettings;
}

export interface AssessedLink extends LinkResult {
  name: string | null;
}

export interface AssessResponse {
  type: 'assess-result';
  jobId: number;
  siteElevationM: number | null;
  results: AssessedLink[];
  candidateCount: number;
  missingTerrain: number;
  elapsedMs: number;
}

const provider = new TerrariumTileProvider();
const post = (m: unknown): void => {
  (self as unknown as { postMessage(msg: unknown): void }).postMessage(m);
};

self.onmessage = (ev: MessageEvent<AssessRequest>) => {
  if (ev.data?.type === 'assess') void handle(ev.data);
};

async function handle(req: AssessRequest): Promise<void> {
  const t0 = performance.now();
  try {
    await provider.warmPoint(req.site);
    const siteElevationM = provider.elevationAt(req.site);

    const results: AssessedLink[] = [];
    let missingTerrain = 0;
    for (const c of req.candidates) {
      await provider.warmPath(req.site, c);
      const r = assessLink({
        provider,
        source: {
          id: 'planned',
          lat: req.site.lat,
          lon: req.site.lon,
          antennaHeightAglM: req.site.antennaHeightAglM,
        },
        target: { id: c.id, lat: c.lat, lon: c.lon, antennaHeightAglM: req.rf.rxHeightAglM },
        rf: req.rf,
        profile: { targetSpacingM: 60, minSamples: 24, maxSamples: 1024 },
      });
      if (r.classification === 'unknown-terrain') missingTerrain += 1;
      results.push({ ...r, name: c.name });
    }

    const response: AssessResponse = {
      type: 'assess-result',
      jobId: req.jobId,
      siteElevationM,
      results,
      candidateCount: req.candidates.length,
      missingTerrain,
      elapsedMs: performance.now() - t0,
    };
    post(response);
  } catch (err) {
    post({
      type: 'assess-error',
      jobId: req.jobId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
