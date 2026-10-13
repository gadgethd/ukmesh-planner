import { describe, expect, it } from 'vitest';
import { localTileCoords, lonLatToGlobalPx, tileOfGlobalPx, tilesForPoints, DEM_ZOOM, TILE_SIZE } from './tilemath.js';
import { freshnessBucket } from './freshness.js';

describe('tilemath', () => {
  it('maps the null island to the world centre at z12', () => {
    const { px, py } = lonLatToGlobalPx(0, 0, DEM_ZOOM);
    const n = 2 ** DEM_ZOOM * TILE_SIZE;
    expect(px).toBeCloseTo(n / 2, 6);
    expect(py).toBeCloseTo(n / 2, 6);
  });

  it('maps a UK point into the expected z12 tile', () => {
    // Newcastle ~ (-1.61, 54.97): expect tile x ~ 2019, y ~ 1295 at z12
    const { px, py } = lonLatToGlobalPx(-1.61, 54.97, DEM_ZOOM);
    const t = tileOfGlobalPx(px, py);
    expect(t.x).toBeGreaterThan(2000);
    expect(t.x).toBeLessThan(2040);
    expect(t.y).toBeGreaterThan(1280);
    expect(t.y).toBeLessThan(1310);
  });

  it('dedupes tiles across a short path', () => {
    const pts = [
      { lat: 54.97, lon: -1.61 },
      { lat: 54.98, lon: -1.6 },
      { lat: 54.97, lon: -1.61 },
    ];
    const tiles = tilesForPoints(pts);
    expect(tiles.length).toBeGreaterThanOrEqual(1);
    expect(tiles.length).toBeLessThanOrEqual(2);
  });
});

describe('localTileCoords', () => {
  it('clamps the outer pixel band to the addressable range', () => {
    // Sample exactly on the tile's right/bottom boundary pixel
    const c = localTileCoords(2019 * TILE_SIZE + 255.9, 1295 * TILE_SIZE + 255.99, { x: 2019, y: 1295 });
    expect(c.lx).toBe(TILE_SIZE - 1);
    expect(c.ly).toBe(TILE_SIZE - 1);
    const mid = localTileCoords(2019 * TILE_SIZE + 12.5, 1295 * TILE_SIZE + 40.25, { x: 2019, y: 1295 });
    expect(mid.lx).toBeCloseTo(12.5, 6);
    expect(mid.ly).toBeCloseTo(40.25, 6);
    const low = localTileCoords(2019 * TILE_SIZE - 0.0001, 1295 * TILE_SIZE, { x: 2019, y: 1295 });
    expect(low.lx).toBe(0);
  });
});

describe('freshness', () => {
  const now = Date.parse('2026-10-13T12:00:00Z');
  it('buckets ages', () => {
    expect(freshnessBucket('2026-10-13T06:00:00Z', now)).toBe('fresh');
    expect(freshnessBucket('2026-10-11T12:00:00Z', now)).toBe('recent');
    expect(freshnessBucket('2026-10-01T12:00:00Z', now)).toBe('stale');
    expect(freshnessBucket('2026-08-01T12:00:00Z', now)).toBe('long');
    expect(freshnessBucket(null, now)).toBe('long');
    expect(freshnessBucket('not-a-date', now)).toBe('long');
  });
});
