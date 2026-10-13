import { describe, expect, it } from 'vitest';
import { sceneOffset, sceneOrigin } from './linkMath.js';

describe('linkMath (3D scene frame)', () => {
  const origin = sceneOrigin(-1.6237, 54.9648);

  it('places a point 1 km east at x ≈ +1000 m', () => {
    const dLon = 1000 / (111_320 * Math.cos((54.9648 * Math.PI) / 180));
    const [x, y, z] = sceneOffset(origin, { lon: -1.6237 + dLon, lat: 54.9648, altM: 0 });
    expect(x).toBeGreaterThan(990);
    expect(x).toBeLessThan(1010);
    expect(Math.abs(y)).toBeLessThan(5);
    expect(Math.abs(z)).toBeLessThan(1);
  });

  it('places a point 1 km north at y ≈ +1000 m (north is positive)', () => {
    const dLat = 1000 / 111_132;
    const [x, y, z] = sceneOffset(origin, { lon: -1.6237, lat: 54.9648 + dLat, altM: 0 });
    expect(Math.abs(x)).toBeLessThan(5);
    expect(y).toBeGreaterThan(990);
    expect(y).toBeLessThan(1010);
    expect(Math.abs(z)).toBeLessThan(1);
  });

  it('maps altitude to z in metres, scaled by the exaggeration', () => {
    const [, , z1] = sceneOffset(origin, { lon: -1.6237, lat: 54.9648, altM: 100 });
    expect(z1).toBeGreaterThan(98);
    expect(z1).toBeLessThan(102);
    const [, , z13] = sceneOffset(origin, { lon: -1.6237, lat: 54.9648, altM: 100 }, 1.3);
    expect(z13).toBeGreaterThan(128);
    expect(z13).toBeLessThan(132);
  });

  it('returns the origin itself at (0, 0, alt)', () => {
    const [x, y, z] = sceneOffset(origin, { lon: -1.6237, lat: 54.9648, altM: 2 });
    expect(Math.abs(x)).toBeLessThan(0.01);
    expect(Math.abs(y)).toBeLessThan(0.01);
    expect(z).toBeGreaterThan(1.9);
    expect(z).toBeLessThan(2.1);
  });
});
