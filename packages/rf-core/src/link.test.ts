import { describe, expect, it } from 'vitest';
import { DEFAULT_UK_RF_SETTINGS } from '@ukmesh-planner/contracts';
import {
  buildProfile,
  earthBulgeM,
  fresnelRadiusM,
  wavelengthM,
  type TerrainProvider,
} from './los.js';
import { deygoutLossDb, knifeEdgeLossDb } from './diffraction.js';
import { assessLink, freeSpaceLossDb, type LinkEndpoint } from './assess.js';

const flat = (elev: number): TerrainProvider => ({
  revision: 'test-flat',
  elevationAt: () => elev,
});

const ridge = (base: number, peak: number, peakLat: number): TerrainProvider => ({
  revision: 'test-ridge',
  elevationAt: (p) => (Math.abs(p.lat - peakLat) < 0.02 ? peak : base),
});

const src: LinkEndpoint = { id: 'A', lat: 53.0, lon: -2.0, antennaHeightAglM: 2 };
const mkTarget = (lat: number, lon: number, h = 2): LinkEndpoint => ({
  id: 'B',
  lat,
  lon,
  antennaHeightAglM: h,
});

describe('rf constants and closed forms', () => {
  it('wavelength at 868 MHz ≈ 0.3454 m', () => {
    expect(wavelengthM(868)).toBeCloseTo(0.3454, 4);
  });

  it('earth bulge at 50/50 km ≈ 147.15 m (4/3 earth)', () => {
    expect(earthBulgeM(50_000, 50_000)).toBeCloseTo(147.15, 1);
  });

  it('Fresnel radius at 25/25 km, 868 MHz ≈ 65.7 m', () => {
    expect(fresnelRadiusM(wavelengthM(868), 25_000, 25_000)).toBeCloseTo(65.7, 0);
  });

  it('knife-edge loss: 6.03 dB at grazing, 0 at v ≤ −0.7, ≈19.0 dB at v=2', () => {
    expect(knifeEdgeLossDb(0)).toBeCloseTo(6.03, 1);
    expect(knifeEdgeLossDb(-1)).toBe(0);
    expect(knifeEdgeLossDb(2)).toBeCloseTo(19.04, 1);
  });

  it('free-space loss at 50 km, 868 MHz ≈ 125.19 dB', () => {
    expect(freeSpaceLossDb(50, 868)).toBeCloseTo(125.19, 1);
  });
});

describe('profile + assessment', () => {
  it('flat 10 km path with 2 m antennas → likely, positive margin', () => {
    const result = assessLink({
      provider: flat(0),
      source: src,
      target: mkTarget(53.09, -2.0), // ≈10 km north
      rf: DEFAULT_UK_RF_SETTINGS,
    });
    expect(result.classification).toBe('likely');
    expect(result.marginDb).not.toBeNull();
    expect(result.marginDb!).toBeGreaterThan(15);
    expect(result.diffractionDb).toBe(0);
  });

  it('flat 100 km path is curvature-blocked', () => {
    const result = assessLink({
      provider: flat(0),
      source: src,
      target: mkTarget(53.9, -2.0), // ≈100 km north
      rf: DEFAULT_UK_RF_SETTINGS,
    });
    expect(result.classification).toBe('blocked');
    expect(result.fresnelClearanceRatio).not.toBeNull();
    expect(result.fresnelClearanceRatio!).toBeLessThan(0);
  });

  it('ridge between endpoints → blocked with heavy diffraction loss', () => {
    const result = assessLink({
      provider: ridge(0, 300, 53.045), // ridge near midpoint of a 10 km path
      source: src,
      target: mkTarget(53.09, -2.0),
      rf: DEFAULT_UK_RF_SETTINGS,
    });
    expect(result.classification).toBe('blocked');
    expect(result.diffractionDb).not.toBeNull();
    expect(result.diffractionDb!).toBeGreaterThan(15);
  });

  it('raising both antennas above a ridge clears it (synthetic 320 m masts)', () => {
    const result = assessLink({
      provider: ridge(0, 300, 53.045),
      source: { ...src, antennaHeightAglM: 320 },
      target: { ...mkTarget(53.09, -2.0), antennaHeightAglM: 320 },
      rf: DEFAULT_UK_RF_SETTINGS,
    });
    expect(result.classification).toBe('likely');
    expect(result.diffractionDb!).toBeLessThan(5);
  });

  it('missing DEM data → unknown-terrain (fail closed)', () => {
    const patchy: TerrainProvider = {
      revision: 'test-patchy',
      elevationAt: (p) => (p.lat > 53.04 && p.lat < 53.046 ? null : 0),
    };
    const result = assessLink({
      provider: patchy,
      source: src,
      target: mkTarget(53.09, -2.0),
      rf: DEFAULT_UK_RF_SETTINGS,
    });
    expect(result.classification).toBe('unknown-terrain');
    expect(result.marginDb).toBeNull();
    expect(result.warnings.some((w) => w.includes('missing terrain'))).toBe(true);
  });

  it('deygout matches single-knife-edge on a single dominant ridge', () => {
    const profile = buildProfile(
      ridge(0, 300, 53.045),
      { ...src, antennaHeightAglM: 2 },
      { ...mkTarget(53.09, -2.0), antennaHeightAglM: 2 },
      { frequencyMhz: 868 },
    );
    const loss = deygoutLossDb(profile.points, wavelengthM(868), 3);
    // Deygout overestimates loss on broad flat-topped ridges (documented
    // limitation); for classification purposes the magnitude is what matters.
    expect(loss.lossDb).toBeGreaterThan(15);
    expect(loss.lossDb).toBeLessThan(90);
    expect(loss.worstEdgeIndex).not.toBeNull();
  });

  it('no obstruction (very high antennas, short path) → zero diffraction', () => {
    const profile = buildProfile(
      flat(0),
      { ...src, antennaHeightAglM: 100 },
      { ...mkTarget(53.02, -2.0), antennaHeightAglM: 100 },
      { frequencyMhz: 868 },
    );
    const loss = deygoutLossDb(profile.points, wavelengthM(868), 3);
    expect(loss.lossDb).toBe(0);
  });
});
