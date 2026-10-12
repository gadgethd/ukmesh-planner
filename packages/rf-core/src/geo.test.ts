import { describe, expect, it } from 'vitest';
import {
  haversineDistanceM,
  initialBearingDeg,
  interpolateGreatCircle,
  samplePath,
} from './geo.js';

describe('geo', () => {
  it('London → Manchester great-circle distance ≈ 262 km', () => {
    const d = haversineDistanceM(
      { lat: 51.5074, lon: -0.1278 },
      { lat: 53.4808, lon: -2.2426 },
    );
    expect(d / 1000).toBeGreaterThan(256);
    expect(d / 1000).toBeLessThan(268);
  });

  it('interpolate: endpoints exact, midpoint equidistant', () => {
    const a = { lat: 51.5, lon: -0.1 };
    const b = { lat: 53.5, lon: -2.2 };
    const mid = interpolateGreatCircle(a, b, 0.5);
    const dAM = haversineDistanceM(a, mid);
    const dMB = haversineDistanceM(mid, b);
    expect(Math.abs(dAM - dMB) / dAM).toBeLessThan(0.01);
    const p0 = interpolateGreatCircle(a, b, 0);
    expect(p0.lat).toBeCloseTo(a.lat, 6);
    expect(p0.lon).toBeCloseTo(a.lon, 6);
    const p1 = interpolateGreatCircle(a, b, 1);
    expect(p1.lat).toBeCloseTo(b.lat, 5);
    expect(p1.lon).toBeCloseTo(b.lon, 5);
  });

  it('bearing north ≈ 0°, east ≈ 90°', () => {
    const north = initialBearingDeg({ lat: 51, lon: -1 }, { lat: 52, lon: -1 });
    expect(north).toBeLessThan(1);
    const east = initialBearingDeg({ lat: 51, lon: -1 }, { lat: 51, lon: 0 });
    expect(east).toBeGreaterThan(85);
    expect(east).toBeLessThan(95);
  });

  it('samplePath returns n points with consistent cumulative distance', () => {
    const pts = samplePath({ lat: 51, lon: -2 }, { lat: 53, lon: -1 }, 9);
    expect(pts.length).toBe(9);
    const total = haversineDistanceM({ lat: 51, lon: -2 }, { lat: 53, lon: -1 });
    let sum = 0;
    for (let i = 1; i < pts.length; i += 1) sum += haversineDistanceM(pts[i - 1]!, pts[i]!);
    expect(Math.abs(sum - total) / total).toBeLessThan(0.005);
  });
});
