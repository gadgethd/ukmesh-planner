/**
 * Candidate-site search: pure, deterministic screening and ranking of proposed
 * repeater locations ("where should we put a new node?"). No DOM, no network,
 * no randomness — the same input always yields the same output array, which is
 * what lets the planner ship hand-checked fixtures.
 *
 * ── Screening: screenCandidates ─────────────────────────────────────────────
 * The search rectangle `boundsPx` (global DEM pixel space) is sampled on a
 * square lattice of `step` px with `step = max(8, round(stepPx))` — the 8 px
 * minimum bounds the candidate count. Grid point (i, j) sits at
 * (round(minX + i*step), round(minY + j*step)) and is read as the centre of its
 * step x step cell; the lattice is visited row-major (j outer, i inner).
 * Elevation is sampled nearest-cell from the tile-aligned DEM window at
 * (px - originX, py - originY); cells outside the window or holding NaN
 * (nodata) are skipped.
 *
 * The high-ground threshold is the `quantile` of the sampled elevations
 * (default 0.75) — linear interpolation between closest ranks, over the known
 * samples only. Candidates must sit at or above it.
 *
 * localReliefM = own elevation - mean of the known elevations of the 8
 * neighbouring grid samples (offsets of +-step px). Positive = locally high,
 * which is the isolation bonus the screening score rewards. With fewer than 4
 * neighbours (window edges, nodata) the relief is 0, so edges cannot invent
 * prominence. (The two spec phrasings of this subtraction disagreed; the
 * semantic contract — "positive = locally high", "isolation bonus" — is what
 * this module implements, so the sign is own - mean.)
 *
 * score = 0.8 * elevRankNorm + 0.2 * reliefNorm, where
 *   elevRankNorm = (# kept candidates with strictly lower elevation) / max(1, kept - 1)
 *   reliefNorm   = clamp(localReliefM, -20, 20) / 20   (bonus saturates at +-20 m)
 * i.e. elevation rank dominates and local prominence separates equal-elevation
 * plateaus. Scores are rounded to 6 decimals; output order is score desc, then
 * px asc, py asc, id asc, truncated to `maxCandidates` (default 64). Candidate
 * ids are `c${px}_${py}` in global pixels.
 *
 * ── Ranking: rankCandidates ─────────────────────────────────────────────────
 * Factors, all derived from CandidateEvaluation:
 *   reach     = reach (count of newly reachable repeaters, 0..N)
 *   margin    = clamp(meanTopMarginDb, 0, 40) / 10, and 0 when it is null
 *   isolation = min(nearestRepeaterKm, 20) / 10      (closer = more overlap)
 *   penalty   = 1 / (1 + nearestRepeaterKm)          (overlap cost, subtracted)
 * Goal weights:
 *   reach      -> { reach: 1.0, margin: 0.5, isolation: 0.2 }
 *   resilience -> { reach: 0.6, margin: 0.6, isolation: 0.8 }
 *   balanced   -> { reach: 0.8, margin: 0.5, isolation: 0.5 }
 * score = w.reach*reach + w.margin*margin + w.isolation*isolation - penalty,
 * rounded to 6 decimals; order is score desc, then reach desc, then id asc, and
 * `rank` is 1-based. Non-finite or negative distances/reaches are clamped
 * defensively so one bad record cannot poison the ordering with NaN.
 */

export interface ScreenInput {
  /** Tile-aligned DEM window, row-major, NaN = nodata. */
  dem: { data: Float32Array; width: number; height: number; originX: number; originY: number };
  /** Search rectangle in the same global-pixel space as the DEM window origin. */
  boundsPx: { minX: number; minY: number; maxX: number; maxY: number };
  /** Candidate grid step in pixels (>= 8). */
  stepPx: number;
  /** Keep at most this many candidates (default 64). */
  maxCandidates?: number;
  /** Elevation quantile among sampled cells used as the high-ground threshold (default 0.75). */
  quantile?: number;
}

export interface ScreenedCandidate {
  /** stable: `c${x}_${y}` using grid pixel coords */
  id: string;
  /** candidate position in global pixels (grid centre) */
  px: number;
  py: number;
  /** terrain elevation at the point */
  elevM: number;
  /** elev minus the mean of its 3x3 neighbourhood samples (isolation bonus) */
  localReliefM: number;
  /** screening score: elevation-quantile rank blended with localReliefM */
  score: number;
}

export interface CandidateEvaluation {
  id: string;
  /** Count of repeaters that become newly reachable (likely or marginal). */
  reach: number;
  /** Mean margin (dB) over the top-5 newly reachable repeaters; null when reach = 0. */
  meanTopMarginDb: number | null;
  /** Distance in km to the nearest existing repeater (cost proxy: closer = more overlap). */
  nearestRepeaterKm: number;
  /** Terrain elevation at the candidate (metres ASL). */
  elevM: number;
}

export type CandidateGoal = 'reach' | 'resilience' | 'balanced';

export interface RankedCandidate extends CandidateEvaluation {
  /** 1-based */
  rank: number;
  factors: { reach: number; margin: number; isolation: number; overlapPenalty: number };
  score: number;
  /** human-readable, e.g. 'reaches 7 repeaters (top margins 32 dB avg); 4.2 km from nearest repeater' */
  explanation: string;
}

type DemWindow = ScreenInput['dem'];
type GoalWeights = { reach: number; margin: number; isolation: number };

/** Minimum candidate grid step in pixels; smaller requests are clamped up to it. */
export const MIN_STEP_PX = 8;

const DEFAULT_MAX_CANDIDATES = 64;
const DEFAULT_QUANTILE = 0.75;
/** Relief at or beyond this magnitude saturates the screening bonus (m). */
const RELIEF_SATURATION_M = 20;
/** Fewer known neighbours than this => relief 0 (edges cannot invent prominence). */
const MIN_KNOWN_NEIGHBOURS = 4;
const SCREEN_ELEV_WEIGHT = 0.8;
const SCREEN_RELIEF_WEIGHT = 0.2;
const MARGIN_CAP_DB = 40;
const MARGIN_SCALE_DB = 10;
const ISOLATION_CAP_KM = 20;
const ISOLATION_SCALE_KM = 10;
const SCORE_SCALE = 1e6;

const GOAL_WEIGHTS: Record<CandidateGoal, GoalWeights> = {
  reach: { reach: 1.0, margin: 0.5, isolation: 0.2 },
  resilience: { reach: 0.6, margin: 0.6, isolation: 0.8 },
  balanced: { reach: 0.8, margin: 0.5, isolation: 0.5 },
};

/** Round to 6 decimals so comparisons/ordering are stable across runs. */
function round6(value: number): number {
  const rounded = Math.round(value * SCORE_SCALE) / SCORE_SCALE;
  return rounded === 0 ? 0 : rounded; // normalise -0
}

function clamp(value: number, lo: number, hi: number): number {
  return Math.min(Math.max(value, lo), hi);
}

function compareStrings(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Nearest-cell DEM read; null for nodata (NaN, non-finite) or out-of-window. */
function sampleDem(dem: DemWindow, px: number, py: number): number | null {
  const col = Math.round(px - dem.originX);
  const row = Math.round(py - dem.originY);
  if (col < 0 || col >= dem.width || row < 0 || row >= dem.height) return null;
  const value = dem.data[row * dem.width + col];
  if (value === undefined || !Number.isFinite(value)) return null;
  return value;
}

/** Linear-interpolated quantile of an ascending-sorted, non-empty array. */
function quantileLinear(sortedAsc: readonly number[], q: number): number {
  const n = sortedAsc.length;
  if (n === 0) return Number.NaN;
  const clampedQ = clamp(q, 0, 1);
  const pos = clampedQ * (n - 1);
  const lo = Math.floor(pos);
  const hi = Math.min(lo + 1, n - 1);
  const a = sortedAsc[lo] ?? Number.NaN;
  const b = sortedAsc[hi] ?? Number.NaN;
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN;
  return a + (b - a) * (pos - lo);
}

/** mean(known 8-neighbour samples) subtracted from own elevation (positive = locally high). */
function localRelief(
  samples: ReadonlyArray<number | null>,
  cols: number,
  rows: number,
  i: number,
  j: number,
  ownElevM: number,
): number {
  let sum = 0;
  let count = 0;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      if (di === 0 && dj === 0) continue;
      const ni = i + di;
      const nj = j + dj;
      const value = ni < 0 || ni >= cols || nj < 0 || nj >= rows ? null : (samples[nj * cols + ni] ?? null);
      if (value === null) continue;
      sum += value;
      count++;
    }
  }
  if (count < MIN_KNOWN_NEIGHBOURS) return 0;
  return round6(ownElevM - sum / count);
}

function compareScreened(a: ScreenedCandidate, b: ScreenedCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.px !== b.px) return a.px - b.px;
  if (a.py !== b.py) return a.py - b.py;
  return compareStrings(a.id, b.id);
}

export function screenCandidates(input: ScreenInput): ScreenedCandidate[] {
  const { dem, boundsPx } = input;
  if (!(dem.width > 0) || !(dem.height > 0) || dem.data.length === 0) return [];
  if (
    !Number.isFinite(boundsPx.minX) ||
    !Number.isFinite(boundsPx.minY) ||
    !Number.isFinite(boundsPx.maxX) ||
    !Number.isFinite(boundsPx.maxY)
  ) {
    return [];
  }

  const step = Number.isFinite(input.stepPx) ? Math.max(MIN_STEP_PX, Math.round(input.stepPx)) : MIN_STEP_PX;
  const maxCandidates = Math.max(
    0,
    Math.floor(Number.isFinite(input.maxCandidates) ? (input.maxCandidates as number) : DEFAULT_MAX_CANDIDATES),
  );
  const quantile = clamp(Number.isFinite(input.quantile) ? (input.quantile as number) : DEFAULT_QUANTILE, 0, 1);

  const cols = Math.floor((boundsPx.maxX - boundsPx.minX) / step) + 1;
  const rows = Math.floor((boundsPx.maxY - boundsPx.minY) / step) + 1;
  if (cols <= 0 || rows <= 0) return [];

  // Collect the known samples on the lattice (row-major).
  const samples = new Array<number | null>(cols * rows).fill(null);
  const known: number[] = [];
  for (let j = 0; j < rows; j++) {
    const py = Math.round(boundsPx.minY + j * step);
    for (let i = 0; i < cols; i++) {
      const px = Math.round(boundsPx.minX + i * step);
      const elevM = sampleDem(dem, px, py);
      samples[j * cols + i] = elevM;
      if (elevM !== null) known.push(elevM);
    }
  }
  if (known.length === 0) return [];

  const threshold = quantileLinear([...known].sort((a, b) => a - b), quantile);

  // Keep the at-or-above-quantile samples, in lattice order.
  const kept: number[] = [];
  for (let idx = 0; idx < samples.length; idx++) {
    const elevM = samples[idx] ?? null;
    if (elevM !== null && elevM >= threshold) kept.push(idx);
  }
  if (kept.length === 0) return [];

  // Strictly-lower counts for the elevation rank (first ascending index of each value).
  const lowerByValue = new Map<number, number>();
  const keptSorted = [...kept].map((idx) => samples[idx] ?? Number.NaN).sort((a, b) => a - b);
  for (let k = 0; k < keptSorted.length; k++) {
    const value = keptSorted[k];
    if (value === undefined || lowerByValue.has(value)) continue;
    lowerByValue.set(value, k);
  }
  const rankDenominator = Math.max(1, kept.length - 1);

  const candidates: ScreenedCandidate[] = [];
  for (const idx of kept) {
    const elevM = samples[idx];
    if (elevM === null || elevM === undefined) continue;
    const i = idx % cols;
    const j = Math.floor(idx / cols);
    const px = Math.round(boundsPx.minX + i * step);
    const py = Math.round(boundsPx.minY + j * step);
    const relief = localRelief(samples, cols, rows, i, j, elevM);
    const elevRankNorm = (lowerByValue.get(elevM) ?? 0) / rankDenominator;
    const reliefNorm = clamp(relief, -RELIEF_SATURATION_M, RELIEF_SATURATION_M) / RELIEF_SATURATION_M;
    const score = round6(SCREEN_ELEV_WEIGHT * elevRankNorm + SCREEN_RELIEF_WEIGHT * reliefNorm);
    candidates.push({ id: `c${px}_${py}`, px, py, elevM, localReliefM: relief, score });
  }

  candidates.sort(compareScreened);
  return candidates.slice(0, maxCandidates);
}

function weightsFor(goal: CandidateGoal): GoalWeights {
  return (GOAL_WEIGHTS as Record<string, GoalWeights | undefined>)[goal] ?? GOAL_WEIGHTS.balanced;
}

/** One decimal place, with a trailing '.0' dropped ('32', '4.2', '0.4'). */
function formatDb(value: number): string {
  const fixed = value.toFixed(1);
  return fixed.endsWith('.0') ? fixed.slice(0, -2) : fixed;
}

function explainEvaluation(e: CandidateEvaluation): string {
  const unit = e.reach === 1 ? 'repeater' : 'repeaters';
  const marginPart =
    e.meanTopMarginDb === null || !Number.isFinite(e.meanTopMarginDb)
      ? 'no new coverage'
      : `top margins ${formatDb(e.meanTopMarginDb)} dB avg`;
  const km = Number.isFinite(e.nearestRepeaterKm) ? Math.max(0, e.nearestRepeaterKm) : 0;
  return `reaches ${e.reach} ${unit} (${marginPart}); ${formatDb(km)} km from nearest repeater`;
}

function compareRanked(a: RankedCandidate, b: RankedCandidate): number {
  if (a.score !== b.score) return b.score - a.score;
  if (a.reach !== b.reach) return b.reach - a.reach;
  return compareStrings(a.id, b.id);
}

export function rankCandidates(evals: CandidateEvaluation[], goal: CandidateGoal): RankedCandidate[] {
  const weights = weightsFor(goal);

  const scored: RankedCandidate[] = evals.map((e) => {
    const reachFactor = Number.isFinite(e.reach) ? Math.max(0, e.reach) : 0;
    const marginDb = e.meanTopMarginDb === null || !Number.isFinite(e.meanTopMarginDb) ? 0 : e.meanTopMarginDb;
    const marginFactor = clamp(marginDb, 0, MARGIN_CAP_DB) / MARGIN_SCALE_DB;
    const km = Number.isFinite(e.nearestRepeaterKm) ? Math.max(0, e.nearestRepeaterKm) : 0;
    const isolationFactor = Math.min(km, ISOLATION_CAP_KM) / ISOLATION_SCALE_KM;
    const overlapPenalty = 1 / (1 + km);
    const score = round6(
      weights.reach * reachFactor +
        weights.margin * marginFactor +
        weights.isolation * isolationFactor -
        overlapPenalty,
    );
    return {
      ...e,
      rank: 0, // assigned after the sort
      factors: { reach: reachFactor, margin: marginFactor, isolation: isolationFactor, overlapPenalty },
      score,
      explanation: explainEvaluation(e),
    };
  });

  scored.sort(compareRanked);
  return scored.map((candidate, index) => ({ ...candidate, rank: index + 1 }));
}
