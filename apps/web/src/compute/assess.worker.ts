/**
 * Simple-journey compute worker — tier A (immediate point-to-point).
 *
 * Runs entirely in the visitor's browser; the VPS never performs RF math.
 * Protocol mirrors the shared compute contract (build brief §6.3): the same
 * request/result shapes will be reused by the WebGPU tier at Stage 4.
 */
import { assessLink, buildProfile, haversineDistanceM, type LinkResult } from '@ukmesh-planner/rf-core';
import type { RfSettings } from '@ukmesh-planner/contracts';
import { TerrariumTileProvider } from './terrain-provider.js';
import { lonLatToGlobalPx, DEM_ZOOM } from '../lib/tilemath.js';
import { globalPxToLonLat } from './coverage/params.js';
import {
  screenCandidates,
  rankCandidates,
  type CandidateEvaluation,
  type CandidateGoal,
  type RankedCandidate,
} from '../advanced/candidates.js';

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

self.onmessage = (ev: MessageEvent<AssessRequest | ProfileRequest | CandidatesRequest>) => {
  if (ev.data?.type === 'assess') void handle(ev.data);
  if (ev.data?.type === 'profile') void handleProfile(ev.data);
  if (ev.data?.type === 'candidates') void handleCandidates(ev.data);
};

/** Advanced: candidate-site search over the coverage-style search box. */
export interface CandidatesRequest {
  type: 'candidates';
  jobId: number;
  site: { lat: number; lon: number; antennaHeightAglM: number };
  /** Search box half-size in km around the site. */
  halfSizeKm: number;
  /** Screening grid step in global pixels. */
  stepPx: number;
  maxCandidates: number;
  goal: CandidateGoal;
  rf: RfSettings;
  /** Bounded repeater list to evaluate against (already distance-filtered). */
  repeaters: Array<{ id: string; name: string | null; lat: number; lon: number }>;
}

export interface CandidatesResponse {
  type: 'candidates-result';
  jobId: number;
  candidates: Array<RankedCandidate & { lat: number; lon: number }>;
  screenedCount: number;
  evaluatedCount: number;
  elapsedMs: number;
}

const CANDIDATE_PROFILE = { targetSpacingM: 60, minSamples: 24, maxSamples: 1024 };
const MAX_EVAL_REPEATERS = 40;

async function handleCandidates(req: CandidatesRequest): Promise<void> {
  const t0 = performance.now();
  try {
    const centre = lonLatToGlobalPx(req.site.lon, req.site.lat, DEM_ZOOM);
    const mPerPx = (156543.03392 * Math.cos((req.site.lat * Math.PI) / 180)) / 2 ** DEM_ZOOM;
    const halfPx = (req.halfSizeKm * 1000) / mPerPx;
    const boundsPx = {
      minX: centre.px - halfPx,
      minY: centre.py - halfPx,
      maxX: centre.px + halfPx,
      maxY: centre.py + halfPx,
    };
    const dem = await provider.windowRaster(
      { x: boundsPx.minX, y: boundsPx.minY },
      { x: boundsPx.maxX, y: boundsPx.maxY },
    );
    if (!dem) throw new Error('DEM window exceeds the memory budget');
    const screened = screenCandidates({ dem, boundsPx, stepPx: req.stepPx, maxCandidates: req.maxCandidates });

    const evals: CandidateEvaluation[] = [];
    const positions = new Map<string, { lat: number; lon: number }>();
    const total = screened.length;
    let done = 0;
    for (const c of screened) {
      const ll = globalPxToLonLat(c.px, c.py);
      await provider.warmPoint(ll);
      const g = provider.elevationAt(ll);
      done += 1;
      if (g === null) {
        post({ type: 'candidates-progress', jobId: req.jobId, done, total, backend: 'cpu' });
        continue;
      }
      const source = { lat: ll.lat, lon: ll.lon, antennaHeightAglM: req.site.antennaHeightAglM };
      const within = req.repeaters
        .map((r) => ({ r, d: haversineDistanceM(source, r) }))
        .filter((x) => x.d / 1000 <= req.rf.maxRangeKm)
        .sort((a, b) => a.d - b.d)
        .slice(0, MAX_EVAL_REPEATERS);
      let reach = 0;
      const margins: number[] = [];
      let nearestKm = Number.POSITIVE_INFINITY;
      for (const { r, d } of within) {
        nearestKm = Math.min(nearestKm, d / 1000);
        await provider.warmPath(source, r, CANDIDATE_PROFILE);
        const res = assessLink({
          provider,
          source: { id: 'candidate', ...source },
          target: { id: r.id, lat: r.lat, lon: r.lon, antennaHeightAglM: req.rf.rxHeightAglM },
          rf: req.rf,
          profile: CANDIDATE_PROFILE,
        });
        if (res.classification === 'likely' || res.classification === 'marginal') {
          reach += 1;
          if (res.marginDb !== null) margins.push(res.marginDb);
        }
      }
      const top = margins.sort((a, b) => b - a).slice(0, 5);
      const meanTop = top.length > 0 ? top.reduce((a, b) => a + b, 0) / top.length : null;
      evals.push({
        id: c.id,
        reach,
        meanTopMarginDb: meanTop,
        nearestRepeaterKm: Number.isFinite(nearestKm) ? nearestKm : 999,
        elevM: g,
      });
      positions.set(c.id, { lat: ll.lat, lon: ll.lon });
      post({ type: 'candidates-progress', jobId: req.jobId, done, total, backend: 'cpu' });
    }

    const ranked = rankCandidates(evals, req.goal).map((r) => ({
      ...r,
      lat: positions.get(r.id)?.lat ?? req.site.lat,
      lon: positions.get(r.id)?.lon ?? req.site.lon,
    }));
    post({
      type: 'candidates-result',
      jobId: req.jobId,
      candidates: ranked,
      screenedCount: screened.length,
      evaluatedCount: evals.length,
      elapsedMs: performance.now() - t0,
    });
  } catch (err) {
    post({ type: 'candidates-error', jobId: req.jobId, error: err instanceof Error ? err.message : String(err) });
  }
}

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
