import { describe, expect, it } from 'vitest';
import {
  bilinearSample,
  decodeTerrarium,
  encodeTerrarium,
  nearestSample,
  type ElevationRaster,
} from './dem.js';

describe('dem', () => {
  it('terrarium decode/encode round-trips within 1/256 m', () => {
    for (const v of [0, 123.5, -400, 1085, 8848.86, -12000]) {
      const [r, g, b] = encodeTerrarium(v);
      const back = decodeTerrarium(r, g, b);
      expect(back).toBeCloseTo(v, 2);
    }
  });

  it('known encodings', () => {
    expect(decodeTerrarium(128, 0, 0)).toBe(0);
    // 65535:255,255,255
    expect(decodeTerrarium(255, 255, 255)).toBeCloseTo(32767.996, 2);
  });

  it('bilinear interpolation on a small raster', () => {
    const raster: ElevationRaster = {
      width: 2,
      height: 2,
      data: new Float32Array([100, 200, 300, 500]),
    };
    const centre = bilinearSample(raster, 0.5, 0.5);
    expect(centre).toBeCloseTo((100 + 200 + 300 + 500) / 4, 5);
    expect(bilinearSample(raster, 0, 0)).toBe(100);
    expect(bilinearSample(raster, 1, 1)).toBe(500);
  });

  it('fails closed on unknown pixels and out-of-bounds', () => {
    const raster: ElevationRaster = {
      width: 2,
      height: 2,
      data: new Float32Array([100, Number.NaN, 300, 500]),
    };
    expect(bilinearSample(raster, 0.5, 0.5)).toBeNull(); // touches NaN corner
    expect(bilinearSample(raster, -1, 0)).toBeNull();
    expect(bilinearSample(raster, 5, 0)).toBeNull();
    expect(nearestSample(raster, 0, 1)).toBe(300);
    expect(nearestSample(raster, 1, 0)).toBeNull(); // NaN at (1,0)
  });
});
