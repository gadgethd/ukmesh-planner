/**
 * Simple-journey compute worker — tier A (immediate point-to-point).
 *
 * Runs entirely in the visitor's browser; the VPS never performs RF math.
 * Protocol mirrors the shared compute contract (build brief §6.3): the same
 * request/result shapes will be reused by the WebGPU tier at Stage 4.
 */
import {
  assessLink,
  buildProfile,
  haversineDistanceM,
  computeItmPathLoss,
  sampleItmProfile,
  itmSignalBand,
  type ItmSignalBand,
  type LinkResult,
} from '@ukmesh-planner/rf-core';
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


/**
 * Visual clearance held above the ground when the sight ray would clip it.
 * 20 m: verified numerically against the real terrain (SO Terrain 50) — with
 * the full-resolution profile no drawn segment comes within 2 m of the
 * surface, so lines visibly float and can never graze/enter a hillside.
 */
/** Visual clearance held above the ground when the sight ray would clip it. */
const DRAWN_CLEARANCE_M = 20;
/** Hard cap on drawn points per link (profiles are <= 200 by construction). */
const DRAWN_PATH_MAX_POINTS = 200;
/**
 * Visual arc lift: at true antenna altitude a 10-27 km link is visually flat
 * against the terrain (height separation of ~0.1% of the span — invisible),
 * so the drawn line reads as "glued to the ground". The drawn path therefore
 * arcs overhead like a strung wire: endpoints at the antennas, rising to a
 * visible height at midspan, scaled with the link's length. This is a pure
 * visualisation choice (flagged in the legend) — path loss numbers are
 * unaffected.
 */
const DRAWN_ARC_MIN_M = 80;
const DRAWN_ARC_MAX_M = 1500;
const DRAWN_ARC_FRACTION = 0.12;
/**
 * The arc is a pure visual device (like MapLibre's terrain exaggeration):
 * at true scale the pitch projection compresses 1.5 km of height into ~25 px
 * at z10 (pixel-measured), which still reads as "flat". Multiplying the arc
 * component only (endpoints stay at the antennas) makes the links visibly
 * float. Ben's steer (2026-10-14): keep it a GENTLE arc — 6x read as "way
 * too high up", 1.6x as "still too high": 0.5x is the settled look.
 * Path loss numbers are unaffected.
 */
const DRAWN_ARC_VISUAL_MULT = 0.5;

/**
 * Build the drawn 3D path for a link from its sampled profile: the straight
 * sight ray (hTx -> hRx) wherever it clears the terrain, lifted to
 * terrain + clearance wherever the ray would be inside a hill. The drawn
 * line therefore never disappears into the terrain, and the lift is visible
 * as the line riding over the ridges it has to clear.
 */
export function buildDrawnPath(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
  profile: { dists: number[]; heights: number[] },
  hTxM: number,
  hRxM: number,
): AssessedPathPoint[] {
  const n = profile.dists.length;
  if (n === 0) return [];
  const dTotal = profile.dists[n - 1] || 1;
  // Full resolution (the profile's own ~100 m spacing): downsampling lets the
  // straight segment between two points cut under an unsampled terrain spike
  // (measured down to 1.1 m clearance — visually grazing the hillside).
  const step = Math.max(1, Math.ceil(n / DRAWN_PATH_MAX_POINTS));
  const arcH = Math.min(DRAWN_ARC_MAX_M, Math.max(DRAWN_ARC_MIN_M, DRAWN_ARC_FRACTION * dTotal));
  const idxs: number[] = [];
  for (let i = 0; i < n; i += step) idxs.push(i);
  if ((n - 1) % step !== 0) idxs.push(n - 1);
  // Pass 1: raw altitude per point (terrain-clearing base + gentle arc).
  const alts = idxs.map((i) => {
    const t = profile.dists[i]! / dTotal;
    const ray = hTxM + (hRxM - hTxM) * t;
    const base = Math.max(ray, profile.heights[i]! + DRAWN_CLEARANCE_M);
    return base + DRAWN_ARC_VISUAL_MULT * arcH * Math.sin(Math.PI * t);
  });
  // Pass 2: light moving-average smoothing — the per-point terrain floor
  // makes small slope changes between samples that render as kinks ("ugly,
  // faceted" — Ben 2026-10-14). Smoothing keeps the arc fluid; endpoints are
  // preserved, then the terrain floor is re-applied so the clearance
  // guarantee is exact.
  const SMOOTH_WINDOW = 2;
  const out: AssessedPathPoint[] = [];
  for (let k = 0; k < idxs.length; k += 1) {
    const i = idxs[k]!;
    const t = profile.dists[i]! / dTotal;
    let sum = 0;
    let cnt = 0;
    for (let w = Math.max(0, k - SMOOTH_WINDOW); w <= Math.min(idxs.length - 1, k + SMOOTH_WINDOW); w += 1) {
      sum += alts[w]!;
      cnt += 1;
    }
    const smoothed = sum / cnt;
    const altM = Math.max(smoothed, profile.heights[i]! + DRAWN_CLEARANCE_M);
    out.push({ lat: a.lat + t * (b.lat - a.lat), lon: a.lon + t * (b.lon - a.lon), altM });
  }
  return out;
}

export interface AssessRequest {
  type: 'assess';
  jobId: number;
  site: { lat: number; lon: number; antennaHeightAglM: number };
  candidates: AssessCandidate[];
  rf: RfSettings;
  /** Calibrated MeshCore-convention threshold (defaults inside the model). */
  calibration?: { usablePathLossDb: number };
}

export interface AssessedPathPoint {
  lat: number;
  lon: number;
  /** Drawn altitude ASL, metres. */
  altM: number;
}

export interface AssessedLink extends LinkResult {
  name: string | null;
  /** Ground elevation at the target, for 3D LOS rendering (null = unknown). */
  targetGroundM: number | null;
  /**
   * Drawn 3D path for the link (downsampled terrain profile): the straight
   * sight ray where it clears the terrain, lifted just above the ground
   * where the ray would clip a hill — so the drawn line is a genuine 3D
   * object that never disappears into the terrain. Null when terrain was
   * unavailable.
   */
  itmPath: AssessedPathPoint[] | null;
  /**
   * ITM path loss (dB) — the same model the live MeshCore analytics system
   * uses for neighbour links (MeshCore-convention number). Null when terrain
   * was unavailable along the path.
   */
  itmPathLossDb: number | null;
  itmViable: boolean | null;
  itmBand: ItmSignalBand | null;
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
    const usableThreshold = req.calibration?.usablePathLossDb;
    for (const c of req.candidates) {
      await provider.warmPath(req.site, c, profile);
      const targetGroundM = provider.elevationAt(c);
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
      // MeshCore-convention neighbour metric: ITM path loss via the exact
      // live-system model, sampled on its own linear profile convention.
      let itmPathLossDb: number | null = null;
      let itmViable: boolean | null = null;
      let itmBand: ItmSignalBand | null = null;
      let itmPath: AssessedPathPoint[] | null = null;
      if (r.classification !== 'unknown-terrain') {
        const sampled = sampleItmProfile(
          { lat: req.site.lat, lon: req.site.lon },
          { lat: c.lat, lon: c.lon },
          (lat, lon) => provider.elevationAt({ lat, lon }) ?? 0,
        );
        const hTxM = (siteElevationM ?? 0) + req.site.antennaHeightAglM;
        const hRxM = (targetGroundM ?? 0) + req.rf.rxHeightAglM;
        const itm = computeItmPathLoss({
          ...sampled,
          hTxM,
          hRxM,
          usableThresholdDb: usableThreshold,
        });
        if (Number.isFinite(itm.pathLossDb)) {
          itmPathLossDb = itm.pathLossDb;
          itmViable = itm.viable;
          itmBand = itmSignalBand(itm.pathLossDb, usableThreshold);
          itmPath = buildDrawnPath(req.site, c, sampled, hTxM, hRxM);
        }
      }
      results.push({ ...r, name: c.name, targetGroundM, itmPathLossDb, itmViable, itmBand, itmPath });
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
