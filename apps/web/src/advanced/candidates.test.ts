import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MIN_STEP_PX,
  rankCandidates,
  screenCandidates,
  type CandidateEvaluation,
  type CandidateGoal,
  type ScreenInput,
} from './candidates.js';

const W = 64;
const H = 64;
const ORIGIN_X = 1000;
const ORIGIN_Y = 2000;
const STEP_PX = 8;
const BASE_M = 10;
const RIDGE_M = 100;
const PEAK_M = 140;
const VALLEY_M = 0;
/** Grid sites inside the DEM's 10x10 nodata corner patch (local coords). */
const NODATA_GRID: ReadonlyArray<readonly [number, number]> = [
  [0, 0],
  [0, 8],
  [8, 0],
  [8, 8],
];

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('expected a value, got undefined');
  return value;
}

/** id a screenCandidates grid point at local window coords should carry. */
function gid(localX: number, localY: number): string {
  return `c${ORIGIN_X + localX}_${ORIGIN_Y + localY}`;
}

/**
 * 64x64 DEM window: flat 10 m, a 100 m ridge across local columns 28..36, a
 * 140 m peak at local (32,32), a 0 m pit at local (8,32) and a 10x10 nodata
 * patch in the top-left corner. On an 8 px lattice that is 64 grid sites,
 * 4 of them nodata, so 60 known samples: 51 at 10 m, 7 at 100 m, 1 at 140 m
 * and 1 at 0 m.
 */
function buildDem(): Float32Array {
  const data = new Float32Array(W * H);
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      let value = BASE_M;
      if (col >= 28 && col <= 36) value = RIDGE_M;
      if (col <= 9 && row <= 9) value = Number.NaN;
      data[row * W + col] = value;
    }
  }
  data[32 * W + 32] = PEAK_M;
  data[32 * W + 8] = VALLEY_M;
  return data;
}

function makeInput(overrides: Partial<ScreenInput> = {}): ScreenInput {
  return {
    dem: { data: buildDem(), width: W, height: H, originX: ORIGIN_X, originY: ORIGIN_Y },
    boundsPx: { minX: ORIGIN_X, minY: ORIGIN_Y, maxX: ORIGIN_X + W - 1, maxY: ORIGIN_Y + H - 1 },
    stepPx: STEP_PX,
    ...overrides,
  };
}

describe('screenCandidates', () => {
  it('keeps only sites at or above the elevation quantile, peak first', () => {
    // q = 0.9: sorted samples are [0, 10 x51, 100 x7, 140], so the threshold is
    // 100 m under any rank convention and only the ridge column survives.
    const high = screenCandidates(makeInput({ quantile: 0.9 }));

    expect(high.map((c) => c.id)).toEqual([
      gid(32, 32),
      gid(32, 0),
      gid(32, 8),
      gid(32, 16),
      gid(32, 24),
      gid(32, 40),
      gid(32, 48),
      gid(32, 56),
    ]);
    expect(high).toHaveLength(8);
    expect(high.every((c) => c.elevM >= RIDGE_M)).toBe(true);

    const peak = must(high.find((c) => c.id === gid(32, 32)));
    expect(peak.elevM).toBe(PEAK_M);
    expect(peak.px).toBe(ORIGIN_X + 32);
    expect(peak.py).toBe(ORIGIN_Y + 32);
    expect(peak.score).toBe(1); // elevation rank 1.0, relief saturates
    // 140 m minus the mean of its 8 lattice neighbours (100,100,10x6) = 32.5
    expect(peak.localReliefM).toBeCloseTo(107.5, 6);
    expect(peak.localReliefM).toBeGreaterThan(0);

    // Ridge sites tie at score 0.2 (rank 0, saturated relief) -> py order.
    const flank = must(high.find((c) => c.id === gid(32, 8)));
    expect(flank.elevM).toBe(RIDGE_M);
    expect(flank.score).toBeCloseTo(0.2, 6);
    expect(flank.localReliefM).toBeCloseTo(67.5, 6);
  });

  it('applies the default 0.75 quantile and reports relief signs around the pit', () => {
    const q75 = screenCandidates(makeInput({ quantile: 0.75 }));
    // Threshold 10 m: everything except the 0 m pit, i.e. 59 of 60 known sites.
    expect(q75).toHaveLength(59);
    expect(q75.some((c) => c.id === gid(8, 32))).toBe(false);
    expect(Math.min(...q75.map((c) => c.elevM))).toBe(BASE_M);
    expect(Math.max(...q75.map((c) => c.elevM))).toBe(PEAK_M);

    const all = screenCandidates(makeInput({ quantile: 0 }));
    expect(all).toHaveLength(60); // 64 lattice sites minus 4 nodata
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);

    const valley = must(all.find((c) => c.id === gid(8, 32)));
    expect(valley.elevM).toBe(VALLEY_M);
    expect(valley.localReliefM).toBeCloseTo(-10, 6);
    expect(valley.localReliefM).toBeLessThan(0);
    // Scores come back in descending order across the whole set.
    const scores = all.map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));

    // A plain flat site, a site beside the pit (10 m - mean(70/8) = 1.25 m) and
    // a trough hard against the ridge, which is the most locally low site of all
    // (10 m - mean(390/8) = -38.75 m) and outranks the pit downwards.
    expect(must(all.find((c) => c.id === gid(48, 40))).localReliefM).toBe(0);
    expect(must(all.find((c) => c.id === gid(8, 24))).localReliefM).toBeCloseTo(1.25, 6);
    const trough = must(all.find((c) => c.id === gid(40, 24)));
    expect(trough.localReliefM).toBeCloseTo(-38.75, 6);
    expect(trough.score).toBeLessThan(valley.score);
  });

  it('excludes nodata and sites with too few known neighbours for relief', () => {
    const all = screenCandidates(makeInput({ quantile: 0 }));
    for (const [lx, ly] of NODATA_GRID) {
      expect(all.some((c) => c.id === gid(lx, ly))).toBe(false);
    }
    // (0,56) sits in the window corner: only 2 of its 8 lattice neighbours exist
    // inside the window, so relief is pinned to 0 instead of inventing prominence.
    expect(must(all.find((c) => c.id === gid(0, 56))).localReliefM).toBe(0);
  });

  it('respects maxCandidates and the 8 px minimum step', () => {
    const top3 = screenCandidates(makeInput({ quantile: 0.9, maxCandidates: 3 }));
    expect(top3.map((c) => c.id)).toEqual([gid(32, 32), gid(32, 0), gid(32, 8)]);

    const none = screenCandidates(makeInput({ quantile: 0.9, maxCandidates: 0 }));
    expect(none).toEqual([]);

    // Steps below the documented minimum are clamped up to 8 px.
    expect(screenCandidates(makeInput({ stepPx: 1 }))).toEqual(
      screenCandidates(makeInput({ stepPx: MIN_STEP_PX })),
    );
  });

  it('samples through the DEM window origin and skips sites outside it', () => {
    // Bounds one step past the window's right edge: the extra column samples
    // outside the window and must be dropped.
    const extended = screenCandidates({
      ...makeInput({ quantile: 0 }),
      boundsPx: { minX: ORIGIN_X, minY: ORIGIN_Y, maxX: ORIGIN_X + W - 1 + STEP_PX, maxY: ORIGIN_Y + H - 1 },
    });
    expect(extended).toHaveLength(60);
    expect(extended.some((c) => c.px > ORIGIN_X + W - 1)).toBe(false);

    // Same lattice, DEM window parked at a different global origin: nothing is
    // addressable, so nothing is screened.
    const misplaced = screenCandidates({
      ...makeInput({ quantile: 0 }),
      dem: { data: buildDem(), width: W, height: H, originX: 0, originY: 0 },
    });
    expect(misplaced).toEqual([]);
  });

  it('is deterministic and does not mutate its input', () => {
    const a = screenCandidates(makeInput({ quantile: 0.75 }));
    const b = screenCandidates(makeInput({ quantile: 0.75 }));
    expect(a).toEqual(b);
    expect(a).not.toBe(b);

    const shared = makeInput({ quantile: 0.9 });
    const dataBefore = Float32Array.from(shared.dem.data);
    const first = screenCandidates(shared);
    const second = screenCandidates(shared);
    expect(second).toEqual(first);
    expect(shared.dem.data).toEqual(dataBefore);
    expect(shared.boundsPx).toEqual({ minX: ORIGIN_X, minY: ORIGIN_Y, maxX: ORIGIN_X + W - 1, maxY: ORIGIN_Y + H - 1 });
  });

  it('returns nothing for empty bounds or an all-nodata window', () => {
    const empty = screenCandidates(
      makeInput({ boundsPx: { minX: ORIGIN_X, minY: ORIGIN_Y, maxX: ORIGIN_X - 1, maxY: ORIGIN_Y - 1 } }),
    );
    expect(empty).toEqual([]);

    const nodata = new Float32Array(W * H).fill(Number.NaN);
    const allNodata = screenCandidates({
      ...makeInput(),
      dem: { data: nodata, width: W, height: H, originX: ORIGIN_X, originY: ORIGIN_Y },
    });
    expect(allNodata).toEqual([]);
  });
});

interface CandidateFixture {
  computedBy: string;
  entries: CandidateEvaluation[];
  expectedTop3: Record<CandidateGoal, string[]>;
  expectedTop3Scores: Record<CandidateGoal, number[]>;
  expectedBottomTwo: string[];
}

const GOALS: readonly CandidateGoal[] = ['reach', 'resilience', 'balanced'];
const fixture = JSON.parse(
  readFileSync(new URL('./candidates.fixture.json', import.meta.url), 'utf8'),
) as CandidateFixture;

describe('rankCandidates', () => {
  it('loads the hand-checked fixture', () => {
    expect(fixture.computedBy).toBe('hand-checked per module formula');
    expect(fixture.entries).toHaveLength(12);
    expect(new Set(fixture.entries.map((e) => e.id)).size).toBe(12);
    for (const goal of GOALS) {
      expect(fixture.expectedTop3[goal]).toHaveLength(3);
      expect(fixture.expectedTop3Scores[goal]).toHaveLength(3);
    }
  });

  it('returns the fixture top-3, full rank numbering and every entry, per goal', () => {
    for (const goal of GOALS) {
      const ranked = rankCandidates(fixture.entries, goal);

      expect(ranked.map((c) => c.id).slice(0, 3)).toEqual(fixture.expectedTop3[goal]);
      fixture.expectedTop3Scores[goal].forEach((expected, index) => {
        expect(must(ranked[index]).score).toBeCloseTo(expected, 6);
      });
      expect(ranked.map((c) => c.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
      expect([...ranked.map((c) => c.id)].sort()).toEqual([...fixture.entries.map((e) => e.id)].sort());
      expect(ranked.slice(-2).map((c) => c.id)).toEqual(fixture.expectedBottomTwo);
      expect(ranked.every((c) => c.explanation.length > 0)).toBe(true);
    }
  });

  it("recomputes one entry's factors and scores by hand", () => {
    // c160_168: reach 9, margins 36 dB, 13.5 km from the nearest repeater.
    const entry = must(fixture.entries.find((e) => e.id === 'c160_168'));
    const marginFactor = 36 / 10; // clamp(36, 0, 40) / 10
    const isolationFactor = 13.5 / 10; // min(13.5, 20) / 10
    const overlapPenalty = 1 / (1 + 13.5); // 1/14.5

    const byGoal: Record<CandidateGoal, { reach: number; margin: number; isolation: number; score: number }> = {
      // w.reach*9 + w.margin*3.6 + w.isolation*1.35 - 1/14.5
      reach: { reach: 1.0, margin: 0.5, isolation: 0.2, score: 11.001034 },
      resilience: { reach: 0.6, margin: 0.6, isolation: 0.8, score: 8.571034 },
      balanced: { reach: 0.8, margin: 0.5, isolation: 0.5, score: 9.606034 },
    };

    for (const goal of GOALS) {
      const ranked = must(rankCandidates([entry], goal)[0]);
      const w = byGoal[goal];

      expect(ranked.rank).toBe(1);
      expect(ranked.factors.reach).toBe(9);
      expect(ranked.factors.margin).toBeCloseTo(marginFactor, 10);
      expect(ranked.factors.isolation).toBeCloseTo(isolationFactor, 10);
      expect(ranked.factors.overlapPenalty).toBeCloseTo(overlapPenalty, 12);
      expect(w.reach * 9 + w.margin * marginFactor + w.isolation * isolationFactor - overlapPenalty).toBeCloseTo(
        w.score,
        6,
      );
      expect(ranked.score).toBeCloseTo(w.score, 6);
      expect(ranked.explanation).toBe(
        'reaches 9 repeaters (top margins 36 dB avg); 13.5 km from nearest repeater',
      );
      // Pass-through of the evaluation fields.
      expect(ranked.elevM).toBe(75);
      expect(ranked.nearestRepeaterKm).toBe(13.5);
      expect(ranked.meanTopMarginDb).toBe(36);
    }

    // c136_136: reach 8, 15 dB, 0.4 km -> 8 + 0.75 + 0.008 - 1/1.4 under 'reach'.
    const tight = must(rankCandidates([must(fixture.entries.find((e) => e.id === 'c136_136'))], 'reach')[0]);
    expect(tight.factors).toEqual({ reach: 8, margin: 1.5, isolation: 0.04, overlapPenalty: 1 / 1.4 });
    expect(tight.score).toBeCloseTo(8 + 0.5 * 1.5 + 0.2 * 0.04 - 1 / 1.4, 6);
    expect(tight.score).toBeCloseTo(8.043714, 6);
  });

  it('phrases reach-0 candidates without margin numbers', () => {
    const noCoverage = must(fixture.entries.find((e) => e.id === 'c168_56'));
    const ranked = must(rankCandidates([noCoverage], 'balanced')[0]);
    expect(ranked.meanTopMarginDb).toBeNull();
    expect(ranked.factors.margin).toBe(0);
    expect(ranked.explanation).toBe('reaches 0 repeaters (no new coverage); 11 km from nearest repeater');

    const single = must(rankCandidates([{ ...noCoverage, reach: 1, meanTopMarginDb: 12 }], 'reach')[0]);
    expect(single.explanation).toBe('reaches 1 repeater (top margins 12 dB avg); 11 km from nearest repeater');
  });

  it('flips the order of a broad-but-overlapping site and a distant thin site', () => {
    // A: maximal reach, zero isolation (on top of an existing repeater).
    const broad: CandidateEvaluation = {
      id: 'cbroad',
      reach: 9,
      meanTopMarginDb: 0,
      nearestRepeaterKm: 0,
      elevM: 100,
    };
    // B: thin reach, maximal isolation, perfect margins.
    const distant: CandidateEvaluation = {
      id: 'cdistant',
      reach: 2,
      meanTopMarginDb: 36,
      nearestRepeaterKm: 20,
      elevM: 50,
    };
    const pair = [broad, distant];

    // reach:   1.0*9 + 0.5*0 + 0.2*0   - 1/1     = 8.0        (broad wins)
    //           1.0*2 + 0.5*3.6 + 0.2*2 - 1/21    = 4.152381
    const byReach = rankCandidates(pair, 'reach');
    expect(byReach.map((c) => c.id)).toEqual(['cbroad', 'cdistant']);
    expect(must(byReach[0]).score).toBeCloseTo(8, 6);
    expect(byReach[0]?.rank).toBe(1);

    // resilience: 0.6*9 + 0.6*0 + 0.8*0   - 1/1   = 4.4        (distant wins)
    //             0.6*2 + 0.6*3.6 + 0.8*2 - 1/21  = 4.912381
    const byResilience = rankCandidates(pair, 'resilience');
    expect(byResilience.map((c) => c.id)).toEqual(['cdistant', 'cbroad']);
    expect(must(byResilience[0]).score).toBeCloseTo(4.912381, 6);
    expect(must(byResilience[0]).factors.isolation).toBeCloseTo(2, 10);
    expect(must(byResilience[0]).factors.overlapPenalty).toBeCloseTo(1 / 21, 12);

    // balanced keeps broad ahead but only by the reach weight.
    expect(rankCandidates(pair, 'balanced').map((c) => c.id)).toEqual(['cbroad', 'cdistant']);

    // The pair itself is not reordered, and equal scores break on reach then id.
    expect(pair.map((e) => e.id)).toEqual(['cbroad', 'cdistant']);
    const tied = rankCandidates(
      [
        { id: 'czz', reach: 4, meanTopMarginDb: 20, nearestRepeaterKm: 5, elevM: 100 },
        { id: 'caa', reach: 4, meanTopMarginDb: 20, nearestRepeaterKm: 5, elevM: 100 },
      ],
      'balanced',
    );
    expect(tied.map((c) => c.id)).toEqual(['caa', 'czz']);
  });

  it('handles empty input', () => {
    expect(rankCandidates([], 'reach')).toEqual([]);
    expect(rankCandidates([], 'resilience')).toEqual([]);
    expect(rankCandidates([], 'balanced')).toEqual([]);
  });
});
