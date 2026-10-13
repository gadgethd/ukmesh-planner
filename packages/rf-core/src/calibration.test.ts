import { describe, expect, it } from 'vitest';
import {
  calibrateFromObservedLinks,
  pathLossBand,
  weightedQuantile,
  DEFAULT_USABLE_PATH_LOSS_DB,
} from './calibration.js';

describe('link calibration (live-system mirror)', () => {
  it('falls back to documented defaults below 24 usable links', () => {
    const cal = calibrateFromObservedLinks([{ pathLossDb: 120, observedCount: 5 }]);
    expect(cal.usablePathLossDb).toBe(DEFAULT_USABLE_PATH_LOSS_DB);
    expect(cal.green).toBe(121.5);
    expect(cal.amber).toBe(129.5);
    expect(cal.samples).toBe(0);
  });

  it('weighted quantile is a step function (live-system semantics)', () => {
    expect(weightedQuantile([10, 20, 30], [1, 1, 1], 0)).toBe(10);
    expect(weightedQuantile([10, 20, 30], [1, 1, 1], 0.5)).toBe(20);
    expect(weightedQuantile([10, 20, 30], [1, 1, 1], 1)).toBe(30);
    // heavily weighted high value pulls the median up to it
    expect(weightedQuantile([10, 30], [1, 9], 0.5)).toBe(30);
  });

  it('calibrates thresholds from a synthetic distribution', () => {
    const rows = Array.from({ length: 100 }, (_, i) => ({ pathLossDb: 100 + i, observedCount: 3 }));
    const cal = calibrateFromObservedLinks(rows);
    expect(cal.samples).toBe(100);
    // q90 of 100..199 ≈ 189 -> clamped to default+2 = 139.5
    expect(cal.usablePathLossDb).toBe(139.5);
    expect(cal.green).toBeLessThan(cal.amber);
    expect(cal.amber).toBeLessThanOrEqual(cal.usablePathLossDb);
  });

  it('clamps the usable threshold into [110, default+2]', () => {
    const low = calibrateFromObservedLinks(
      Array.from({ length: 30 }, () => ({ pathLossDb: 60, observedCount: 1 })),
    );
    expect(low.usablePathLossDb).toBe(110);
    const high = calibrateFromObservedLinks(
      Array.from({ length: 30 }, () => ({ pathLossDb: 220, observedCount: 1 })),
    );
    expect(high.usablePathLossDb).toBe(DEFAULT_USABLE_PATH_LOSS_DB + 2);
  });

  it('bands a path loss against calibrated thresholds', () => {
    const cal = { usablePathLossDb: 137.5, green: 121.5, amber: 129.5, samples: 100 };
    expect(pathLossBand(110, cal)).toBe('green');
    expect(pathLossBand(125, cal)).toBe('amber');
    expect(pathLossBand(135, cal)).toBe('red');
  });
});
