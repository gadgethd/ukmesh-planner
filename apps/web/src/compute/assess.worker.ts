/**
 * Simple-journey compute worker — tier A (immediate point-to-point).
 *
 * Runs entirely in the visitor's browser; the VPS never performs RF math.
 * Protocol mirrors the shared compute contract (build brief §6.3): the same
 * request/result shapes will be reused by the WebGPU tier at Stage 4.
 */
import { assessLink, buildProfile, type LinkResult } from '@ukmesh-planner/rf-core';
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

/** Advanced-mode precision profile request (two arbitrary endpoints). */
export interface ProfileEndpoint {
  lat: number;
  lon: number;
  antennaHeightAglM: number;
}

export interface ProfileRequest {
  type: 'profile';
  jobId: number;
  a: ProfileEndpoint;
  b: ProfileEndpoint;
  rf: RfSettings;
}

export interface ProfileResponse {
  type: 'profile-result';
  jobId: number;
  points: Array<{
    distanceM: number;
    terrainM: number | null;
    lineHeightM: number;
    bulgeM: number;
    fresnelRadiusM: number;
    clearanceM: number | null;
  }>;
  totalDistanceM: number;
  unknownCount: number;
  worstIndex: number | null;
  worstClearanceRatio: number | null;
  aGroundM: number | null;
  bGroundM: number | null;
  marginDb: number | null;
  classification: string;
  diffractionDb: number | null;
  freeSpaceLossDb: number;
  elapsedMs: number;
}

const provider = new TerrariumTileProvider();
const post = (m: unknown): void => {
  (self as unknown as { postMessage(msg: unknown): void }).postMessage(m);
};

self.onmessage = (ev: MessageEvent<AssessRequest | ProfileRequest>) => {
  if (ev.data?.type === 'assess') void handle(ev.data);
  if (ev.data?.type === 'profile') void handleProfile(ev.data);
};

async function handleProfile(req: ProfileRequest): Promise<void> {
  const t0 = performance.now();
  try {
    const profileOpts = { targetSpacingM: 60, minSamples: 24, maxSamples: 1024 };
    await provider.warmPath(req.a, req.b, profileOpts);
    const aGroundM = provider.elevationAt(req.a);
    const bGroundM = provider.elevationAt(req.b);
    const profile = buildProfile(provider, req.a, req.b, {
      frequencyMhz: req.rf.frequencyMhz,
      ...profileOpts,
    });
    const r = assessLink({ provider, source: { id: 'a', ...req.a }, target: { id: 'b', ...req.b }, rf: req.rf, profile: profileOpts });
    const response: ProfileResponse = {
      type: 'profile-result',
      jobId: req.jobId,
      points: profile.points.map((p) => ({
        distanceM: p.distanceM,
        terrainM: Number.isFinite(p.terrainM) ? p.terrainM : null,
        lineHeightM: p.lineHeightM,
        bulgeM: p.earthBulgeAdjM,
        fresnelRadiusM: p.fresnelRadiusM,
        clearanceM: Number.isFinite(p.clearanceM) ? p.clearanceM : null,
      })),
      totalDistanceM: profile.totalDistanceM,
      unknownCount: profile.unknownCount,
      worstIndex: profile.worstIndex,
      worstClearanceRatio: profile.worstClearanceRatio,
      aGroundM,
      bGroundM,
      marginDb: r.marginDb,
      classification: r.classification,
      diffractionDb: r.diffractionDb,
      freeSpaceLossDb: r.freeSpaceLossDb,
      elapsedMs: performance.now() - t0,
    };
    post(response);
  } catch (err) {
    post({ type: 'profile-error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
  }
}

async function handle(req: AssessRequest): Promise<void> {
  const t0 = performance.now();
  try {
    await provider.warmPoint(req.site);
    const siteElevationM = provider.elevationAt(req.site);

    const results: AssessedLink[] = [];
    let missingTerrain = 0;
    const profile = { targetSpacingM: 60, minSamples: 24, maxSamples: 1024 };
    for (const c of req.candidates) {
      await provider.warmPath(req.site, c, profile);
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
        profile,
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
